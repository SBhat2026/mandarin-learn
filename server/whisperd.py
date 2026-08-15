#!/usr/bin/env python3
"""Persistent Whisper worker.

Invoking the `mlx_whisper` CLI once per utterance costs ~3.5s of Python startup and
model loading before a single sample is decoded — measured against ~1.7s of actual
inference for a short clip. Push-to-talk could absorb that; a hands-free conversation,
where the microphone re-arms after every teacher turn, cannot: it is most of the gap
between the learner finishing their sentence and hearing a reply.

So the model is loaded once and kept resident. One request per line of stdin, one
result per line of stdout, strictly in order — mlx is not thread-safe and utterances
are inherently serial anyway (there is only one microphone).

  in   {"path": "/tmp/utt.webm", "prompt": "..."}
  out  {"text": "...", "segments": [{start, end, avg_logprob, no_speech_prob}, ...]}
  out  {"error": "..."}                     on a per-request failure; the worker lives on
"""
import sys
import json

MODEL = sys.argv[1] if len(sys.argv) > 1 else "mlx-community/whisper-large-v3-turbo"

SEGMENT_FIELDS = ("start", "end", "avg_logprob", "no_speech_prob", "compression_ratio")


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    try:
        import numpy as np
        import mlx_whisper
    except Exception as e:                       # no mlx on this host — caller falls back
        emit({"fatal": f"import failed: {e}"})
        return 1

    def run(audio, prompt=None):
        return mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=MODEL,
            language="zh",
            task="transcribe",
            # Greedy. The temperature-fallback ladder is what lets Whisper wander into
            # invented text on marginal audio, and a learner's quiet single syllable is
            # exactly marginal audio.
            temperature=0.0,
            # Each utterance is independent; carrying the previous transcript forward is
            # what makes Whisper repeat itself into a loop over a long session.
            condition_on_previous_text=False,
            initial_prompt=prompt or None,
            verbose=None,
        )

    # Load and compile the graph now, so the learner's FIRST utterance is fast too.
    # Reporting ready only after this means the Node side never sends a request into a
    # model that is still warming.
    #
    # Warming on SILENCE is not enough, and this cost real debugging: silence makes the
    # decoder emit end-of-transcript immediately, so its kernels never compile and the
    # first genuine sentence still paid ~15s. Warming on a real Mandarin clip — one
    # bundled second of 这是猫 — exercises encoder and decoder both. Silence remains the
    # fallback for when the asset is missing, since a slow worker beats no worker.
    warm = sys.argv[2] if len(sys.argv) > 2 else ""
    try:
        run(warm if warm else np.zeros(16000, dtype=np.float32))
    except Exception:
        try:
            run(np.zeros(16000, dtype=np.float32))
        except Exception as e:
            emit({"fatal": f"warmup failed: {e}"})
            return 1
    emit({"ready": True, "model": MODEL})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            r = run(req["path"], req.get("prompt"))
            emit({
                "text": r.get("text", ""),
                "segments": [{k: s.get(k) for k in SEGMENT_FIELDS} for s in r.get("segments", [])],
            })
        except Exception as e:
            emit({"error": str(e)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
