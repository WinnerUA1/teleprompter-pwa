const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(__dirname + '/app.js', 'utf8');
const fn = source.slice(source.indexOf('async function checkMicrophoneAudio()'), source.indexOf('document.querySelector("#checkAudio").addEventListener'));
async function check(amplitude, options = {}) {
    const elements = {};
    const track = { enabled: true, muted: !!options.muted, readyState: 'live', stop() { throw new Error('Shared camera audio must stay alive'); } };
    let timer, input, recorder;
    const context = {
        document: { querySelector(id) { return elements[id] ||= { pause() {} }; } },
        stream: { getAudioTracks: () => [track] }, recordingStream: null, cameraStarting: false,
        audioCheckRecorder: null, audioCheckUrl: null,
        MediaStream: class { constructor(tracks) { input = tracks; } },
        MediaRecorder: class {
            static isTypeSupported() { return true; }
            constructor() { recorder = this; this.state = 'inactive'; }
            start() { this.state = 'recording'; }
            stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob(['audio'], { type: 'audio/mp4' }) }); this.onstop(); }
        },
        window: {}, Blob, URL: { createObjectURL: () => 'blob:audio-check', revokeObjectURL() {} },
        requestAnimationFrame: () => 1, cancelAnimationFrame() {},
        setTimeout(fn, delay) { assert.equal(delay, 4000); timer = fn; }
    };
    if (!options.noContext) context.window.AudioContext = class {
        constructor() { this.state = 'running'; }
        resume() { return new Promise(() => {}); }
        close() { return Promise.resolve(); }
        createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
        createAnalyser() { return { getFloatTimeDomainData(samples) { samples.fill(amplitude); } }; }
    };
    vm.createContext(context);
    vm.runInContext(fn, context);
    await vm.runInContext('checkMicrophoneAudio()', context);
    if (options.muted) {
        assert.equal(recorder, undefined);
        assert.match(elements['#audioCheckStatus'].textContent, /не передає звук/);
        return;
    }
    assert.equal(input.length, 1);
    assert.equal(input[0], track);
    assert.equal(context.audioCheckRecorder, recorder);
    timer();
    assert.equal(context.audioCheckRecorder, null);
    assert.equal(elements['#checkAudio'].disabled, false);
    assert.equal(elements['#audioCheckPlayback'].src, 'blob:audio-check');
    assert.match(elements['#audioCheckStatus'].textContent, options.noContext ? /Вимірювання рівня недоступне/ : amplitude ? /Сигнал надходить/ : /Сигнал відсутній/);
}
(async () => {
    await check(0.2);
    await check(0);
    await check(0, { muted: true });
    await check(0, { noContext: true });
    console.log('PASS: direct audio-only input, audible/silent signal, muted track, hung resume does not block, no Web Audio fallback, shared track preserved');
})().catch(error => { console.error(error); process.exitCode = 1; });
