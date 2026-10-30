import modal


APP_NAME = "clash-ai-voxcpm-tn"
MODEL_CACHE_PATH = "/cache/huggingface"

app = modal.App(APP_NAME)
model_cache = modal.Volume.from_name("clash-ai-voxcpm-cache", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libsndfile1")
    .pip_install(
        "fastapi",
        "numpy",
        "soundfile",
        "uvicorn[standard]",
        "voxcpm",
    )
    .env(
        {
            "HF_HOME": MODEL_CACHE_PATH,
            "TORCHDYNAMO_DISABLE": "1",
            "VOXCPM_MODEL_ID": "Code-Quasar/voxcpm-tn",
        }
    )
    .add_local_python_source("app")
)


@app.function(
    image=image,
    gpu="T4",
    memory=32768,
    timeout=300,
    scaledown_window=30,
    max_containers=1,
    volumes={MODEL_CACHE_PATH: model_cache},
    secrets=[modal.Secret.from_name("clash-voice-secret")],
)
@modal.asgi_app()
def fastapi_app():
    from app import app as api

    return api
