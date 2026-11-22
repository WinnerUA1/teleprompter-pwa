const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");

async function main() {
    const elements = {};
    const transforms = [];
    let lastTransform;
    let encodedPixels;
    let videoTrackStopped = false;
    let cameraCaptureStopped = false;
    const audioTrack = { kind: "audio" };
    const outputStream = {
        tracks: [{ kind: "video", stop() { videoTrackStopped = true; } }],
        getVideoTracks() { return this.tracks.filter(track => track.kind === "video"); },
        addTrack(track) { this.tracks.push(track); }
    };
    function element() {
        const classes = new Set();
        return {
            value: "2.5", min: "0.5", max: "30", style: { setProperty() {} },
            videoWidth: 3, videoHeight: 1,
            classList: { add: k => classes.add(k), remove: k => classes.delete(k), contains: k => classes.has(k) },
            handlers: {}, children: [], offsetHeight: 1000, clientHeight: 600,
            addEventListener(name, fn) { this.handlers[name] = fn; },
            append(...nodes) { this.children.push(...nodes); },
            prepend(node) { this.children.unshift(node); node.parent = this; },
            remove() { this.parent.children = this.parent.children.filter(node => node !== this); },
            pause() { this.paused = true; },
            removeAttribute(name) { delete this[name]; },
            load() { this.loaded = true; },
            setAttribute(name, value) { this[name] = value; },
            getContext() { return {
                setTransform(...args) { lastTransform = args; transforms.push(args); },
                drawImage() { encodedPixels = lastTransform[0] === -1 ? ["C", "B", "A"] : ["A", "B", "C"]; }
            }; },
            captureStream() { return outputStream; },
            async play() {}
            ,click() { this.clicked = true; }
        };
    }
    let shared;
    let shareError;
    const stream = { addTrack() {}, getVideoTracks() { return [{ kind: 'video', stop() {} }]; }, getTracks() { return [{ stop() { cameraCaptureStopped = true; } }]; }, getAudioTracks() { return [audioTrack]; } };
    let recorderInput;
    const revoked = [];
    const context = {
        document: {
            querySelector(id) { return elements[id] ||= element(); },
            createElement: element, body: element()
        },
        navigator: {
            mediaDevices: { async getUserMedia() { return stream; } },
            canShare(data) { return data.files[0].type === "video/mp4"; },
            async share(data) { if (shareError) throw shareError; shared = data; }
        },
        localStorage: { getItem() { return null; } },
        window: { isSecureContext: true, location: { protocol: "https:", hostname: "test" }, addEventListener() {} },
        Blob, File, URL: { createObjectURL() { return "blob:recording"; }, revokeObjectURL(url) { revoked.push(url); } },
        requestAnimationFrame() { return 1; }, cancelAnimationFrame() {}
    };
    context.MediaRecorder = class {
        static isTypeSupported() { return true; }
        constructor(input) { recorderInput = input; this.state = "inactive"; this.mimeType = "video/mp4"; }
        start() { this.state = "recording"; }
        stop() { this.state = "inactive"; this.ondataavailable({ data: new Blob(["video"]) }); this.onstop(); }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(__dirname + "/app.js", "utf8"), context);
    elements["#settingsButton"].handlers.click();
    assert.equal(elements["#settingsDialog"].open, "");
    elements["#closeSettings"].handlers.click();
    assert.equal(elements["#settingsDialog"].open, undefined);
    await vm.runInContext("startCamera()", context);
    assert.equal(elements["#camera"].style.transform, "none");
    assert.deepEqual(encodedPixels, ["C", "B", "A"]);
    elements["#recordButton"].handlers.click();
    assert.equal(recorderInput, outputStream);
    assert(recorderInput.tracks.includes(audioTrack));
    assert.deepEqual(encodedPixels, ["C", "B", "A"]);
    elements["#flipVideoButton"].handlers.click();
    assert.equal(vm.runInContext("mirrorVideo", context), true);
    elements["#stopRecordingButton"].handlers.click();
    assert.equal(videoTrackStopped, true);
    elements["#recordings"].children = [];
    elements["#flipVideoButton"].handlers.click();
    assert.deepEqual(encodedPixels, ["A", "B", "C"]);
    assert(transforms.some(args => args[0] === -1 && args[4] === 3));
    elements["#flipVideoButton"].handlers.click();
    assert.deepEqual(encodedPixels, ["C", "B", "A"]);
    vm.runInContext('offerRecording(new Blob(["video"], {type:"video/mp4"}), "video/mp4;codecs=avc1")', context);
    const card = elements["#recordings"].children[0];
    assert.equal(elements["#historyDialog"].open, "");
    assert.equal(elements["#recordingsCount"].textContent, "1");
    assert.equal(elements["#recordingsEmpty"].hidden, true);
    const [preview, save, download] = card.children;
    assert.equal(preview.src, "blob:recording");
    assert.equal(save.hidden, false);
    assert(download.download.endsWith(".mp4"));
    await save.handlers.click();
    assert.equal(shared.files[0].type, "video/mp4");
    assert.equal(shared.files[0].size, 5);
    shareError = { name: "AbortError" };
    await save.handlers.click();
    assert.equal(save.disabled, false);
    assert.equal(elements["#recordings"].children.length, 1);
    context.navigator.canShare = () => false;
    vm.runInContext('offerRecording(new Blob(["video"]), "video/webm")', context);
    assert.equal(elements["#recordings"].children[0].children[1].hidden, true);
    assert.equal(elements["#recordings"].children.length, 2);
    const otherCard = elements["#recordings"].children[0];
    card.children[4].handlers.click();
    assert.equal(elements["#recordings"].children.length, 1);
    assert.equal(elements["#recordings"].children[0], otherCard);
    assert.equal(preview.paused, true);
    assert.equal(preview.src, undefined);
    assert.equal(preview.loaded, true);
    assert.deepEqual(revoked, ["blob:recording"]);
    elements["#systemCameraButton"].handlers.click();
    assert.equal(cameraCaptureStopped, true);
    assert.equal(elements["#camera"].srcObject, null);
    assert.equal(elements["#systemCameraInput"].clicked, true);
    assert.equal(elements["#systemCameraInput"].capture, 'user');
    const original = new File(['original-camera-video-and-audio'], 'IMG_1234.MOV', { type: 'video/quicktime' });
    context.navigator.canShare = () => true;
    shareError = null;
    elements["#systemCameraInput"].files = [original];
    elements["#systemCameraInput"].handlers.change();
    const imported = elements["#recordings"].children[0];
    assert.equal(imported.children[2].download, 'IMG_1234.MOV');
    await imported.children[1].handlers.click();
    assert.equal(shared.files[0], original, 'Preserve original native-camera file, format and audio');
    const count = elements["#recordings"].children.length;
    elements["#systemCameraInput"].files = [];
    elements["#systemCameraInput"].handlers.change();
    assert.equal(elements["#recordings"].children.length, count);
    console.log("PASS: preview/recording parity, audio preserved, sharing, native camera releases web capture, original MOV retained, cancellation");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
