import io
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

import app as speech_app


@pytest.fixture(scope="session")
def client():
    with TestClient(speech_app.app) as test_client:
        response = test_client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok", "stt": True, "tts": True}
        yield test_client


def test_transcribes_real_wav(client: TestClient):
    fixture = Path(__file__).with_name("smoke.wav")
    with fixture.open("rb") as audio:
        response = client.post(
            "/v1/audio/transcriptions",
            files={"file": (fixture.name, audio, "audio/wav")},
        )

    assert response.status_code == 200, response.text
    assert response.json()["text"].strip()


def test_synthesizes_decodable_native_rate_wav(client: TestClient):
    response = client.post(
        "/v1/audio/speech",
        json={"input": "The BB voice proof is ready.", "voice": "Aiden"},
    )

    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("audio/wav")
    audio, sample_rate = sf.read(io.BytesIO(response.content), dtype="float32")
    assert speech_app.tts_model is not None
    assert sample_rate == speech_app.tts_model.sample_rate
    assert audio.ndim == 1
    assert audio.size > sample_rate // 4
    assert np.isfinite(audio).all()
    assert np.max(np.abs(audio)) > 0.001
