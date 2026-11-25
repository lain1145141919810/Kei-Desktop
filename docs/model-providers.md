# Model provider contract v1

A locally installed Kei SDK plugin registers one or more model capabilities. The model registry can discover, select and invoke an enabled provider without changing the caller. The existing chat route continues to use its current configuration.

## Register a provider

Declare the feature and a dedicated action in the plugin's `metadata.yaml`.

```yaml
schemaVersion: 1
apiVersion: 1
id: example.speech
name: Example speech
version: 1.0.0
requiresFeatures: [model-providers-v1]
permissions: [model.provide.tts]
actions:
  - id: speech.synthesize
    scope: model.provide.tts
modelProviders:
  - capability: tts
    action: speech.synthesize
    models: [speech-small-v1]
    requiresCredential: true
```

Use the ordinary SDK `context.register()` call in `initialize(context)`. The handler receives `{capability, model, input}`. The approved environment reference is resolved by the host. Its value is available as `context.model_credential` only for the invocation. Keep endpoint settings with the provider, and return only the capability output described below. A provider action cannot be attached to an iframe entry or use a page's host broker.

## Discover and select in the trusted admin window

```js
const listed = await window.kei.models.list();
if (!listed.ok) throw new Error(listed.error.code);
const tts = listed.value.providers.filter(provider =>
    provider.capability === "tts" && provider.enabled);

const reply = await window.kei.models.select("tts", {
    pluginId: "example.speech",
    model: "speech-small-v1",
    credentialRef: "KEI_EXAMPLE_SPEECH_TOKEN",
});
if (!reply.ok) throw new Error(reply.error.code);
```

Display `selections[capability].state` as `ready`, `unavailable`, or `credential_unavailable`. Use `select(capability, {pluginId: null})` to clear the choice. Keep capability selections independent. Disable/uninstall uses the normal plugin controls. A missing selected provider stays unavailable until the operator enables it again with its scope, or chooses a replacement. The registry does not choose a fallback on its own.

## Call from the trusted desktop window

```js
const result = await window.kei.models.invoke("tts", {
    text: "おかえりなさい。",
    voice: "kei",
    locale: "ja-JP",
});
if (!result.ok) throw new Error(result.error.code);
const { mime, base64 } = result.value.output.audio;
// Decode as playback bytes and enqueue on the existing turn/segment lease.
const bytes = Uint8Array.fromBase64(base64);
```

| Capability | Input | Output |
| --- | --- | --- |
| TTS | `{text, voice?, locale?}` | `{audio: {mime, base64}}` |
| ASR | `{audio: {mime, base64}, locale?}` | `{text, segments?}`, with optional ordered `{text, startMs, endMs}` intervals |
| Vision | `{image: {mime, base64}, prompt, locale?}` | `{text}` |
| Embedding | `{texts: string[]}` | `{dimensions, vectors}` in input order |

Use only images or audio that the user approved for that invocation. The host bounds JSON to 2 MiB and each media argument/output to 750,000 base64 characters, accepts PNG/JPEG and WAV/MP3/Ogg/FLAC signatures, and checks provider results. The caller still owns decoding and rendering. Embedding callers should key indexes on `pluginId`, `providerVersion`, `model` and `dimensions`.

The trusted local HTTP equivalents are `GET /v1/models`, `PUT /v1/models/selection/{capability}` and `POST /v1/models/invoke/{capability}` with `{input}`. Use the host bearer token in the main process. Never pass it into a renderer or plugin iframe.

Provider v1 uses complete requests with the current worker deadline and declares `streaming: false` and `cancellation: false`. A second request to a busy worker receives `model_provider_busy`. A changed selection or revoked worker invalidates a late response. An unhealthy worker is disabled and can be explicitly enabled after recovery. See `tests/backend_acceptance/verify_model_providers.py` for two independently packaged fixtures, credential handling and recovery traces. The supplied fixtures validate the contract and do not implement model inference.
