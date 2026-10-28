# Copyright 2026 SASU Sentient Art
# SPDX-License-Identifier: Apache-2.0
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "numpy",
#   "mlx-whisper; sys_platform == 'darwin' and platform_machine == 'arm64'",
#   "faster-whisper>=1.1; sys_platform != 'darwin' or platform_machine != 'arm64'",
#   "av<19; sys_platform != 'darwin' or platform_machine != 'arm64'",   # PyAV 19 broke faster-whisper's decode_audio (metadata_errors)
#   "pywhispercpp==1.5.1; sys_platform != 'darwin' or platform_machine == 'arm64'",   # --backend whispercpp (Metal on Apple silicon; no Intel Mac wheel)
# ]
# ///
"""Add the voice of a feedback recording to its feedback.ks, on the clock of the strokes.

    uv run tools/transcribe.py <deck>/feedback/<session>/feedback.ks <audio> [--gap 350] [--silence -40] [--lang fr]
                               [--backend mlx|faster|whispercpp] [--model <model>]

Whisper runs on this machine and gives the time of each word; the model (large-v3-turbo) is downloaded once.
Two engines, the same model: mlx-whisper on a Mac with Apple silicon, faster-whisper elsewhere (Windows, Linux, Intel
Macs: on an NVIDIA GPU when CUDA works, else on the CPU). --backend forces one (faster-whisper also runs on a Mac).
--backend whispercpp runs whisper.cpp on the ggml models already on this machine (e.g. those of a dictation app):
--model is a ggml-*.bin file, or a name (large-v3-turbo, large-v3-turbo-q5_0, …) read as ggml-<name>.bin from the
folder $WHISPER_CPP_MODELS (downloaded there when missing). $WHISPER_BACKEND and $WHISPER_MODEL set --backend and
--model, so the server's runs use them too.
The GPU needs the CUDA 12 libraries: the server adds them when it finds nvidia-smi (uv run --with nvidia-cublas-cu12
--with nvidia-cudnn-cu12 …); without them the CPU is used. Prints {"says", "text", "device"}. Words
less than --gap ms apart make one phrase, `Say vN(Span(start, end), Word(start, "text"), …);`: each word keeps its
own start, so a word can be matched with the stroke drawn while it was said. Lines are sorted by start time, so
speech, strokes and slide changes read in the order they happened; a line with no time (Target) stays under the line
before it; Task, Reply and Close lines stay at the end. Say lines already in the file are replaced: a recording can be transcribed again.

Whisper is right about the words and wrong about silence, so the sound level (50 ms steps, --silence dB) corrects it:
- It invents words over silence ("Sous-titrage ST' 501" for a recording with no voice) and its own scores do not tell
  them from speech: a word is kept only when there is sound around it (0.2 s each side).
- It puts the pause before a word inside that word ("tu" written 1.2 s before it was said): a word is the last
  stretch of sound in its span.
- Its vocabulary prompt only reaches the first 30 s: the audio is given in pieces of 10 to 28 s cut in a silence, each
  with the brief (title, text) of the slide shown at its start (Enter lines).
Giving Whisper each stretch of sound alone was tried and is worse: without context "trois" became "etzen", "Hello"
"I'E-D-A-C", and a pen noise became a word.
Raise --silence for a noisy room. Prints {"says", "text"} as JSON.
"""
import argparse, json, re
from pathlib import Path
import os, platform, sys
import numpy as np

p = argparse.ArgumentParser()
p.add_argument("ks"); p.add_argument("audio")
p.add_argument("--silence", type=float, default=-40)
p.add_argument("--gap", type=int, default=350)
p.add_argument("--lang", default="fr")
p.add_argument("--backend", choices=["mlx", "faster", "whispercpp"],
               default=os.environ.get("WHISPER_BACKEND") or ("mlx" if sys.platform == "darwin" and platform.machine() == "arm64" else "faster"))
p.add_argument("--model", default=os.environ.get("WHISPER_MODEL"))
a = p.parse_args()

# One function for every engine: transcribe(16 kHz mono float32 samples, vocabulary) -> [(start s, end s, word)]
device = "mlx"
if a.backend == "mlx":
    import mlx_whisper
    from mlx_whisper.audio import load_audio   # needs ffmpeg
    def transcribe(samples, prompt):
        # condition_on_previous_text off: one misheard phrase does not carry into the next ones
        out = mlx_whisper.transcribe(samples, path_or_hf_repo=a.model or "mlx-community/whisper-large-v3-turbo", language=a.lang,
                                     word_timestamps=True, initial_prompt=prompt, condition_on_previous_text=False, verbose=None)
        return [(w["start"], w["end"], w["word"]) for seg in out["segments"] for w in seg.get("words", [])]
elif a.backend == "whispercpp":
    import _pywhispercpp as pw
    from pywhispercpp.model import Model
    try:
        from mlx_whisper.audio import load_audio   # the decoder this platform has (mlx: needs ffmpeg, gives an mx.array)
    except ImportError:
        from faster_whisper import decode_audio
        load_audio = lambda f: decode_audio(f, sampling_rate=16000)
    # Its own word times are wrong after a silence (a whole phrase at one instant): the times of its attention heads
    # (DTW) are steady, a little late. They need the heads of the model (from its name; other models: the plain times) and no flash attention.
    name = re.sub(r"^ggml-|(-q\d_\d)?(\.bin)?$", "", Path(a.model or "large-v3-turbo").name)
    heads = getattr(pw, "WHISPER_AHEADS_" + name.upper().replace("-", "_").replace(".", "_"), pw.WHISPER_AHEADS_NONE)
    model = Model(a.model or "large-v3-turbo", models_dir=os.environ.get("WHISPER_CPP_MODELS"), redirect_whispercpp_logs_to=None,
                  context_params={"dtw_token_timestamps": heads != pw.WHISPER_AHEADS_NONE, "dtw_aheads_preset": heads, "flash_attn": False},
                  language=a.lang, token_timestamps=True, no_context=True, print_progress=False)
    device = "whispercpp"
    def transcribe(samples, prompt):
        model.transcribe(np.asarray(samples, dtype=np.float32), initial_prompt=prompt or "")
        ctx, words = model._ctx, []   # the tokens are only in the context (no public accessor)
        def whole(b):   # no character cut in two
            try: b.decode(); return True
            except UnicodeDecodeError: return False
        for i in range(pw.whisper_full_n_segments(ctx)):
            first = True
            for j in range(pw.whisper_full_n_tokens(ctx, i)):
                d = pw.whisper_full_get_token_data(ctx, i, j)
                if d.id >= pw.whisper_token_eot(ctx): continue   # [_BEG_], [_TT_…]
                text = pw.whisper_token_to_bytes(ctx, d.id)   # bytes: a token can hold half of "é"
                t = (d.t_dtw if d.t_dtw >= 0 else d.t1) / 100   # late in the token, not at its start
                # a new word after a space, at a segment's start, and at each character in languages written without spaces (as mlx-whisper)
                if first or text.startswith(b" ") or a.lang in ("zh", "ja", "th", "lo", "my", "yue") and whole(words[-1][1]): words.append([t, text])
                else: words[-1] = [t if re.search(rb"[\w\x80-\xff]", text) else words[-1][0], words[-1][1] + text]   # "," is timed in the next word
                first = False
        # a word is somewhere between the end of the word before and its own end: the sound level finds where
        return [(p[0] if p else 0, w[0], w[1].decode(errors="replace")) for p, w in zip([None] + words, words)]
else:
    def cuda_libraries():   # the libraries of the nvidia-* wheels, when uv added them: found before CTranslate2 looks for them
        try:
            import nvidia
        except ImportError:
            return
        import ctypes, glob, os
        for root in nvidia.__path__:
            if sys.platform == "win32":
                for d in glob.glob(os.path.join(root, "*", "bin")):
                    os.add_dll_directory(d); os.environ["PATH"] = d + os.pathsep + os.environ["PATH"]
            else:   # loaded now, globally; twice, as some need others loaded first
                for _ in range(2):
                    for lib in sorted(glob.glob(os.path.join(root, "*", "lib", "lib*.so*"))):
                        try: ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)
                        except OSError: pass
    cuda_libraries()
    from faster_whisper import WhisperModel, decode_audio   # decodes with PyAV: no ffmpeg needed
    load_audio = lambda f: decode_audio(f, sampling_rate=16000)
    model = None
    def transcribe(samples, prompt):
        global model
        def run(m):
            segments, _ = m.transcribe(samples, language=a.lang, word_timestamps=True, initial_prompt=prompt, condition_on_previous_text=False)
            return [(w.start, w.end, w.word) for seg in segments for w in (seg.words or [])]
        if model is None:
            global device
            try:   # an NVIDIA GPU when CUDA and its libraries work; else the CPU
                model = WhisperModel(a.model or "large-v3-turbo", device="auto", compute_type="auto")
                device = model.model.device
                return run(model)
            except Exception:
                model, device = WhisperModel(a.model or "large-v3-turbo", device="cpu", compute_type="int8"), "cpu"
        return run(model)
ks = Path(a.ks)
lines = [l for l in ks.read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("Say ")] if ks.exists() else []

enters = [(int(t), slide) for t, slide in re.findall(r'^Enter \w+\(Time\((\d+)\), "([^"]+)"\);', "\n".join(lines), re.M)]
def vocab(ms, briefs={}):
    slide = next((s for t, s in reversed(enters) if t <= ms), None)
    if slide not in briefs:
        try:
            b = json.loads((ks.parents[2] / "slides" / slide / "brief.json").read_text(encoding="utf-8"))
            briefs[slide] = f"{b.get('title', '')}. {b.get('text', '')}"[:600]
        except (OSError, ValueError, TypeError):
            briefs[slide] = None
    return briefs[slide]

HOP = 800   # 50 ms at 16 kHz
audio = load_audio(a.audio)
frames = audio[: len(audio) // HOP * HOP].reshape(-1, HOP)
level = 20 * np.log10(np.sqrt((frames ** 2).mean(1)) + 1e-9)
loud = level > a.silence
runs = []   # [first, last] frame of each stretch of sound
for f in np.flatnonzero(loud):
    if runs and f - runs[-1][1] <= a.gap / 50: runs[-1][1] = int(f)
    else: runs.append([int(f), int(f)])

# Pieces of 10 to 28 s (200 to 560 frames), cut in the middle of the last silence in that range (none: the quietest frame)
cuts = [0]
while len(frames) - cuts[-1] > 560:
    lo, hi = cuts[-1] + 200, cuts[-1] + 560
    mids = [(r[1] + n[0]) // 2 for r, n in zip(runs, runs[1:]) if lo <= (r[1] + n[0]) // 2 < hi]
    cuts.append(mids[-1] if mids else lo + int(np.argmin(level[lo:hi])))
cuts.append(len(frames))

says = []   # [start ms, end ms, [[start ms, word], …]]
for c0, c1 in zip(cuts, cuts[1:]):
    for start, end, word in transcribe(audio[c0 * HOP: c1 * HOP], vocab(c0 * 50)):
        i, j, text = c0 + int(start * 20), c0 + int(end * 20), word.strip()
        if not loud[max(0, i - 4): j + 5].any(): continue
        on = np.flatnonzero(loud[i: j + 1])
        gaps = np.flatnonzero(np.diff(on) > 3)   # stretches inside the word are split by 0.15 s of silence or more
        first = on[gaps[-1] + 1] if len(gaps) else on[0] if len(on) else 0
        t0 = int(i + first) * 50
        t1 = max(t0, int(i + on[-1] + 1) * 50 if len(on) else j * 50)
        if not says or t0 - says[-1][1] >= a.gap: says.append([t0, t1, [[t0, text]]]); continue
        says[-1][1] = max(says[-1][1], t1)
        # Whisper cuts "m'entends" and "est-ce" in two and times "?" alone: they go back into the word before
        if re.match(r"['’-]", text): says[-1][2][-1][1] += text
        elif not re.search(r"\w", text): says[-1][2][-1][1] += " " + text
        else: says[-1][2].append([t0, text])

blocks, tasks = [], []   # [start ms, lines]: a line with a time, followed by the lines that belong to it
for line in lines:
    m = re.search(r"(?:Span|Time)\((\d+)", line)
    if line.startswith(("Task ", "Reply ", "Close ")): tasks.append(line)
    elif m or not blocks: blocks.append([int(m[1]) if m else -1, [line]])
    else: blocks[-1][1].append(line)
for i, (t0, t1, words) in enumerate(says):
    blocks.append([t0, [f"Say v{i + 1}(Span({t0}, {t1}), {', '.join(f'Word({t}, {json.dumps(x, ensure_ascii=False)})' for t, x in words)});"]])
blocks.sort(key=lambda b: b[0])
# Written beside the file then moved over it: the server reads the file at the same time, for the pictures
tmp = ks.with_name(ks.name + ".tmp")
tmp.write_text("\n".join([l for _, ls in blocks for l in ls] + tasks) + "\n", encoding="utf-8", newline="\n")   # \n on Windows too
tmp.replace(ks)

print(json.dumps({"says": len(says), "text": " ".join(x for s in says for _, x in s[2]), "device": device}, ensure_ascii=False))
