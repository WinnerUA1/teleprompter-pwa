const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(__dirname + '/app.js', 'utf8');
const functions = source.slice(source.indexOf('async function startCamera()'), source.indexOf('function animate('));
function fixture({ devices = [], preferred = '', rawAudio = false, audioSession = true, ignoreDevice = false } = {}) {
    const elements = {};
    const requests = [], events = [], streams = [];
    let live = 0;
    const handlers = {};
    const element = () => ({ value: '', classList: { remove() {}, add() {} }, style: {}, replaceChildren() {}, append() {}, addEventListener() {}, async play() {} });
    const context = {
        document: { querySelector(id) { return elements[id] ||= element(); }, createElement: element },
        window: { isSecureContext: true, location: { protocol: 'https:', hostname: 'test' } },
        localStorage: { removeItem() {}, setItem() {} },
        preferredMicrophone: preferred, rawAudio, stream: null, recordingStream: null, mediaRecorder: null,
        cameraStarting: false, audioCheckRecorder: null, microphoneDeviceSignature: '', cameraFrame: null, currentFacingMode: 'user',
        microphoneSelect: element(), microphoneStatus: {}, recordButton: {}, connectCameraButton: {},
        camera: element(), cameraView: element(), cameraPlaceholder: element(),
        setStatus(message) { context.status = message; }, renderCameraFrames() {}, cancelAnimationFrame() {},
        navigator: { mediaDevices: {
            enumerateDevices: async () => devices,
            addEventListener(name, handler) { handlers[name] = handler; },
            async getUserMedia(constraints) {
                if (constraints.audio === false) {
                    events.push('video');
                    requests.push(constraints);
                    const vtrack = { kind: 'video', stop() {} };
                    return { getVideoTracks: () => [vtrack], getTracks: () => [vtrack] };
                }
                assert.equal(live, 0, 'Previous capture must be released before selecting an input');
                events.push('capture'); requests.push(constraints);
                const id = (typeof constraints.audio === 'object' && constraints.audio?.deviceId?.exact) || 'internal';
                if (id === 'stale') { const error = new Error('disconnected'); error.name = 'OverconstrainedError'; throw error; }
                live++;
                const track = { label: devices.find(d => d.deviceId === id)?.label || 'iPhone Microphone', getSettings: () => ({ deviceId: ignoreDevice ? 'internal' : id }) };
                let stopped = false;
                const added = [];
                const capture = { addTrack(track) { added.push(track); }, getAudioTracks: () => [track], getTracks: () => [...added, { stop() { if (!stopped) { live--; stopped = true; events.push('stop'); } } }] };
                streams.push(capture);
                return capture;
            }
        } }
    };
    if (audioSession) context.navigator.audioSession = { set type(value) { events.push(value); } };
    vm.createContext(context);
    vm.runInContext(functions, context);
    return { context, requests, events, streams, handlers, run: code => vm.runInContext(code, context) };
}
async function main() {
    // 1. Automatic mode: video first, then auto -> audio -> play-and-record, no second reopen
    const external = fixture({ devices: [{ kind: 'audioinput', deviceId: 'internal', label: 'iPhone Microphone' }, { kind: 'audioinput', deviceId: 'wired', label: 'Навушники' }] });
    await external.run('startCamera()');
    assert.equal(external.requests.length, 2, 'Video then audio once in automatic mode');
    assert.equal(external.requests[0].audio, false, 'Video request never acquires audio');
    assert.equal(external.requests[1].audio.deviceId.exact, 'wired', 'Automatic capture must request the discovered external input');
    assert.deepEqual(external.events.slice(0, 4), ['video', 'auto', 'capture', 'play-and-record']);
    assert.match(external.context.microphoneStatus.textContent, /Навушники/, 'Detects Ukrainian external headset label');

    // 2. Raw audio mode disables VoiceProcessingIO constraints even in automatic mode
    const raw = fixture({ rawAudio: true, devices: [{ kind: 'audioinput', deviceId: 'internal', label: 'iPhone Microphone' }] });
    await raw.run('startCamera()');
    assert.deepEqual({ ...raw.requests[1].audio }, { echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    assert.match(raw.context.microphoneStatus.textContent, /лише 1 вхід/);

    // 3. Manual selection uses exact deviceId + rawAudio when enabled
    const manual = fixture({ preferred: 'usb', rawAudio: true, devices: [{ kind: 'audioinput', deviceId: 'usb', label: 'USBAudio1.0' }] });
    await manual.run('startCamera()');
    assert.equal(manual.requests.length, 2);
    assert.equal(manual.requests[0].audio, false);
    assert.equal(manual.requests[1].video, false);
    assert.equal(manual.requests[1].audio.deviceId.exact, 'usb');
    assert.equal(manual.requests[1].audio.echoCancellation, false);
    assert.equal(manual.context.stream.getTracks().filter(track => track.kind === 'video').length, 1);
    assert.match(manual.context.microphoneStatus.textContent, /USBAudio1.0/);

    // 4. Explicit selection mismatch still blocks recording
    const ignored = fixture({ preferred: 'usb', ignoreDevice: true });
    await ignored.run('startCamera()');
    assert.equal(ignored.context.stream, null, 'Never continue recording an input different from the explicit selection');
    assert.match(ignored.context.microphoneStatus.textContent, /інший мікрофон/);

    // 5. Unknown external brand/adapter name detected by fallback (non-built-in)
    const unknownBrand = fixture({ devices: [{ kind: 'audioinput', deviceId: 'internal', label: 'Мікрофон iPhone' }, { kind: 'audioinput', deviceId: 'kt', label: 'KT Micro DAC' }] });
    await unknownBrand.run('startCamera()');
    assert.match(unknownBrand.context.microphoneStatus.textContent, /KT Micro DAC/);

    // 6. Reconnect, devicechange idempotency, recording lock
    await external.run('updateMicrophone()');
    assert.equal(external.requests.length, 4, 'Reconnect fully releases and reacquires the capture');
    const count = external.requests.length;
    await external.handlers.devicechange();
    assert.equal(external.requests.length, count, 'Permission-triggered device events must not create a restart loop');
    external.context.recordingStream = {};
    external.context.mediaRecorder = { state: 'recording' };
    await external.run('updateMicrophone()');
    await external.run('startCamera()');
    assert.equal(external.requests.length, count, 'Never change inputs during recording');

    // 7. A failed explicit input must never silently become the phone mic
    const stale = fixture({ preferred: 'stale' });
    await stale.run('startCamera()');
    assert.equal(stale.requests.length, 2);
    assert.equal(stale.context.preferredMicrophone, 'stale');
    assert.equal(stale.context.stream, null, 'Selected device failure must be visible, with no default-microphone retry');
    const ignoredAuto = fixture({ ignoreDevice: true, devices: [{ kind: 'audioinput', deviceId: 'usb', label: 'USBAudio1.0' }] });
    await ignoredAuto.run('startCamera()');
    assert.equal(ignoredAuto.context.stream, null, 'Automatic external selection must also verify the actual input');

    // 8. Browser without navigator.audioSession still works
    const system = fixture({ audioSession: false });
    await system.run('startCamera()');
    assert.equal(system.requests.length, 2, 'Video then audio without audioSession');
    await system.run('updateMicrophone()');
    assert.equal(system.requests.length, 4, 'Reconnect works even when wired device is not enumerated separately');
    assert.equal(system.context.cameraStarting, false);
    assert.equal(system.context.recordButton.disabled, false);

    console.log('PASS: video-first audio route, raw audio toggle, Ukrainian/unknown external detection, explicit mismatch guard, stale recovery, no devicechange loop, recording lock, audioSession fallback');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
