const defaultScript = `Вітаю! Це мій перший запис за допомогою суфльора.

Натисніть «Текст», щоб вставити власний сценарій.
Потім налаштуйте розмір шрифту та швидкість прокрутки.`;

const camera = document.querySelector("#camera");
const cameraView = document.querySelector("#cameraView");
const flipVideoButton = document.querySelector("#flipVideoButton");
const rawAudioButton = document.querySelector("#rawAudioButton");
const cameraPlaceholder = document.querySelector("#cameraPlaceholder");
const scriptViewport = document.querySelector("#scriptViewport");
const scriptText = document.querySelector("#scriptText");
const scriptInput = document.querySelector("#scriptInput");
const editorDialog = document.querySelector("#editorDialog");
const status = document.querySelector("#status");
const speed = document.querySelector("#speed");
const fontSize = document.querySelector("#fontSize");
const opacity = document.querySelector("#opacity");
const playButton = document.querySelector("#playButton");
const recordButton = document.querySelector("#recordButton");
const restartButton = document.querySelector("#restartButton");
const connectCameraButton = document.querySelector("#connectCameraButton");
const stopRecordingButton = document.querySelector("#stopRecordingButton");

let script = defaultScript;
try {
    script = localStorage.getItem("teleprompter-script") || defaultScript;
} catch (error) {
    // Safari may deny storage access; the prompter must still start.
}
const microphoneSelect = document.querySelector("#microphoneSelect");
const microphoneStatus = document.querySelector("#microphoneStatus");
let preferredMicrophone = "";
try { preferredMicrophone = localStorage.getItem("teleprompter-microphone") || ""; } catch (_) {}
let stream = null;
let cameraStarting = false;
let microphoneDeviceSignature = "";
let audioCheckRecorder = null;
let audioCheckUrl = null;
let mediaRecorder = null;
let recordedChunks = [];
let currentFacingMode = "user";
let isPlaying = false;
let progress = 0;
let animationFrame = null;
let lastFrameTime = null;
let mirrorVideo = true;
let rawAudio = false;
let cameraFrame = null;
let recordingStream = null;
let recordingVideoTrack = null;
let recordingStartedAt = null;

try {
    const settings = JSON.parse(localStorage.getItem("teleprompter-settings") || "{}");
    // Migrate the old direction setting to the original selfie appearance.
    if (settings.videoDirectionVersion === 2) mirrorVideo = settings.mirrorVideo === true;
    rawAudio = settings.rawAudio === true;
    for (const input of [speed, fontSize, opacity]) {
        const value = Number(settings[input.id]);
        if (Number.isFinite(value) && value >= Number(input.min) && value <= Number(input.max)) {
            input.value = String(value);
        }
    }
} catch (error) {
    // Keep defaults if storage is unavailable or contains invalid data.
}

function saveSettings() {
    try {
        localStorage.setItem("teleprompter-settings", JSON.stringify({
            speed: speed.value, fontSize: fontSize.value, opacity: opacity.value, mirrorVideo, rawAudio,
            videoDirectionVersion: 2
        }));
    } catch (error) {
        setStatus("Налаштування працюють, але браузер не дозволив зберегти їх після закриття.");
    }
}

function drawCameraFrame() {
    if (!camera.videoWidth || !camera.videoHeight) return;
    // Freeze the encoded frame dimensions until the recording finishes.
    if (!recordingStream && (cameraView.width !== camera.videoWidth || cameraView.height !== camera.videoHeight)) {
        cameraView.width = camera.videoWidth;
        cameraView.height = camera.videoHeight;
    }
    const context = cameraView.getContext("2d");
    context.setTransform(mirrorVideo ? -1 : 1, 0, 0, 1, mirrorVideo ? cameraView.width : 0, 0);
    context.drawImage(camera, 0, 0, cameraView.width, cameraView.height);
    context.setTransform(1, 0, 0, 1, 0, 0);
}

function renderCameraFrames() {
    drawCameraFrame();
    if (recordingStartedAt !== null) {
        const seconds = Math.floor((Date.now() - recordingStartedAt) / 1000);
        document.querySelector("#recordingTime").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    }
    cameraFrame = requestAnimationFrame(renderCameraFrames);
}

function releaseRecordingStream() {
    // The audio tracks belong to the camera stream and must stay alive.
    if (recordingVideoTrack) recordingVideoTrack.stop();
    recordingVideoTrack = null;
    recordingStream = null;
    flipVideoButton.disabled = false;
    rawAudioButton.disabled = false;
    microphoneSelect.disabled = false;
}

flipVideoButton.setAttribute("aria-pressed", String(mirrorVideo));
flipVideoButton.addEventListener("click", () => {
    if (recordingStream) return;
    mirrorVideo = !mirrorVideo;
    flipVideoButton.setAttribute("aria-pressed", String(mirrorVideo));
    drawCameraFrame();
    saveSettings();
});

rawAudioButton.setAttribute("aria-pressed", String(rawAudio));
rawAudioButton.addEventListener("click", async () => {
    if (recordingStream || cameraStarting) return;
    rawAudio = !rawAudio;
    rawAudioButton.setAttribute("aria-pressed", String(rawAudio));
    saveSettings();
    if (stream) await updateMicrophone();
});

function setStatus(message) {
    status.textContent = message;
    document.querySelector("#historyStatus").textContent = message;
}

function openPanel(panel) {
    if (typeof panel.showModal === "function") {
        if (!panel.open) panel.showModal();
    } else panel.setAttribute("open", "");
}

function closePanel(panel) {
    if (typeof panel.close === "function") panel.close();
    else panel.removeAttribute("open");
}

function updateHistory() {
    const count = document.querySelector("#recordings").children.length;
    document.querySelector("#recordingsCount").textContent = String(count);
    document.querySelector("#recordingsEmpty").hidden = count > 0;
}

for (const [buttonId, dialogId, closeId] of [
    ["#settingsButton", "#settingsDialog", "#closeSettings"],
    ["#historyButton", "#historyDialog", "#closeHistory"]
]) {
    const panel = document.querySelector(dialogId);
    document.querySelector(buttonId).addEventListener("click", () => openPanel(panel));
    document.querySelector(closeId).addEventListener("click", () => closePanel(panel));
}

function renderScript() {
    scriptText.textContent = script;
    scriptText.style.setProperty("--font-size", `${fontSize.value}px`);
    scriptViewport.style.setProperty("--overlay-opacity", `${opacity.value}%`);
    document.querySelector("#speedValue").textContent = speed.value;
    document.querySelector("#fontValue").textContent = `${fontSize.value} px`;
    document.querySelector("#opacityValue").textContent = `${opacity.value}%`;
    progress = 0;
    updatePosition();
}

function updatePosition() {
    const travel = Math.max(0, scriptText.offsetHeight - scriptViewport.clientHeight * 0.58);
    scriptText.style.transform = scriptText.classList.contains("mirrored")
        ? `scaleX(-1) translateY(${-progress * travel}px)`
        : `translateY(${-progress * travel}px)`;
}

async function startCamera() {
    if (audioCheckRecorder) { setStatus("Дочекайтеся завершення перевірки звуку."); return; }
    if (cameraStarting) return;
    if (mediaRecorder && mediaRecorder.state === "recording") {
        setStatus("Спочатку зупиніть запис, потім перемикайте камеру.");
        return;
    }
    if (window.isSecureContext === false) {
        setStatus("Safari не вважає з’єднання захищеним. Потрібен HTTPS із довіреним сертифікатом; простого обходу попередження про сертифікат може бути недостатньо.");
        return;
    }
    if (window.location.protocol !== "https:" && window.location.hostname !== "localhost") {
        setStatus("Safari потребує HTTPS для камери. Відкрийте локальну HTTPS-адресу сервера.");
        return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setStatus("Safari не надає доступу до камери на цій сторінці. Перевірте HTTPS і довіру до сертифіката та відкрийте посилання безпосередньо в Safari.");
        return;
    }

    cameraStarting = true;
    recordButton.disabled = true;
    microphoneSelect.disabled = true;
    document.querySelector("#refreshMicrophones").disabled = true;
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }
    camera.srcObject = null;
    // The capture helper configures the audio route after camera startup.
    if (cameraFrame !== null) cancelAnimationFrame(cameraFrame);
    cameraView.classList.remove("active");
    cameraPlaceholder.classList.remove("hidden");
    connectCameraButton.disabled = true;
    setStatus("Очікуємо відповідь Safari щодо камери та мікрофона…");

    try {
        const capture = async deviceId => {
            // Keep the browser's normal capture processing. Forcing the raw
            // path can change how iOS initializes an external audio interface.
            const audio = rawAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : {};
            if (deviceId) audio.deviceId = { exact: deviceId };
            return captureWithAudioRoute({
                video: { facingMode: currentFacingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
                audio
            });
        };
        stream = await capture(preferredMicrophone);
        await refreshMicrophones();
        camera.srcObject = stream;
        await camera.play();
        camera.style.transform = "none";
        renderCameraFrames();
        cameraView.classList.add("active");
        cameraPlaceholder.classList.add("hidden");
        setStatus("");
    } catch (error) {
        if (cameraFrame !== null) cancelAnimationFrame(cameraFrame);
        if (stream) stream.getTracks().forEach(track => track.stop());
        stream = null;
        camera.srcObject = null;
        const hints = {
            AudioInputMismatchError: "Браузер повернув інший мікрофон замість вибраного. Запис заблоковано, щоб не записати звук із телефона. Спробуйте від’єднати й під’єднати петличку, потім перепідключити мікрофон.",
            NotAllowedError: "Доступ заблоковано. У меню сторінки Safari відкрийте параметри вебсайту й дозвольте камеру та мікрофон. Також перевірте довіру до HTTPS-сертифіката.",
            SecurityError: "Safari заблокував камеру через налаштування безпеки або недовірений HTTPS-сертифікат.",
            NotFoundError: "Камеру або мікрофон не знайдено.",
            NotReadableError: "Не вдалося прочитати камеру чи мікрофон. Закрийте інші програми, які використовують їх, і спробуйте ще раз."
        };
        setStatus(`${hints[error.name] || "Не вдалося запустити камеру."} (${error.name}: ${error.message})`);
        microphoneStatus.textContent = hints[error.name] || `Не вдалося підключити звук: ${error.message}`;
    } finally {
        cameraStarting = false;
        recordButton.disabled = false;
        microphoneSelect.disabled = false;
        document.querySelector("#refreshMicrophones").disabled = false;
        connectCameraButton.disabled = false;
    }
}

async function captureWithAudioRoute(constraints) {
    let video = null;
    let selected = null;
    let requestedDevice = constraints.audio?.deviceId?.exact;
    const session = navigator.audioSession;
    try {
        // Start video first. No camera request may follow microphone routing.
        if (constraints.video) video = await navigator.mediaDevices.getUserMedia({ video: constraints.video, audio: false });
        // Enumeration alone does not select an input. Select the external
        // device before the single audio request, never reopen the default mic.
        if (!requestedDevice && navigator.mediaDevices.enumerateDevices) {
            const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "audioinput");
            requestedDevice = findExternalMicrophone(devices)?.deviceId;
        }
        const audio = { ...(typeof constraints.audio === "object" ? constraints.audio : {}) };
        if (requestedDevice) audio.deviceId = { exact: requestedDevice };
        // WebKit 282939 comment 6: reset -> acquire -> play-and-record.
        // Configure the session around that one selected-input request.
        try { if (session) session.type = "auto"; } catch (_) {}
        selected = await navigator.mediaDevices.getUserMedia({ audio: Object.keys(audio).length ? audio : true, video: false });
        try { if (session) session.type = "play-and-record"; } catch (_) {}
        const track = selected.getAudioTracks()[0];
        const actualDevice = track?.getSettings?.().deviceId;
        if (!track || (requestedDevice && actualDevice && actualDevice !== requestedDevice)) {
            const error = new Error("Вибраний аудіовхід не застосовано. Спробуйте автоматичний системний маршрут.");
            error.name = "AudioInputMismatchError";
            throw error;
        }
        if (video) video.getVideoTracks().forEach(track => selected.addTrack(track));
        return selected;
    } catch (error) {
        selected?.getTracks().forEach(track => track.stop());
        video?.getTracks().forEach(track => track.stop());
        try { if (session && !selected) session.type = "auto"; } catch (_) {}
        throw error;
    }
}

function findExternalMicrophone(devices) {
    const externalPattern = /usb|headset|headphone|wired|external|lavalier|wireless|bluetooth|lightning|adapter|line[\s-]?in|dac|rode|dji|saramonic|boya|hollyland|maono|comica|synco|ulanzi|shure|sennheiser|fifine|петлич|зовніш|гарнітур|навушник|дротов|адаптер|ліній|наушник|проводн|линейн/i;
    const matched = devices.find(device => externalPattern.test(device.label));
    if (matched) return matched;
    if (devices.length <= 1) return undefined;
    const builtInPattern = /^(default|communications|built[\s-]?in|internal|iphone\b|ipad\b|мікрофон\s+iphone|мікрофон\s+ipad|микрофон\s+iphone|микрофон\s+ipad|вбудован|встроенн)/i;
    return devices.find(device => device.label && !builtInPattern.test(device.label.trim()));
}

async function refreshMicrophones() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "audioinput");
    microphoneDeviceSignature = JSON.stringify(devices.map(device => [device.deviceId, device.label]));
    microphoneSelect.replaceChildren();
    const automatic = document.createElement("option");
    automatic.value = "";
    automatic.textContent = "Автоматично (зовнішній мікрофон)";
    microphoneSelect.append(automatic);
    devices.forEach((device, index) => {
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent = device.label || `Мікрофон ${index + 1}`;
        microphoneSelect.append(option);
    });
    microphoneSelect.value = preferredMicrophone;
    if (!stream || recordingStream) return;
    const activeLabel = stream.getAudioTracks()[0]?.label || "системний мікрофон";
    const external = findExternalMicrophone(devices);
    if (devices.length <= 1) {
        microphoneStatus.textContent = `Джерело за даними браузера: ${activeLabel} (браузер бачить лише 1 вхід). Якщо петличка через перехідник не пише — увімкніть «Сирий звук», перевірте її в «Диктофоні» (потрібен TRRS із 3 смужками) або скористайтеся «Запис через камеру iPhone».`;
    } else if (!preferredMicrophone && external && external.label && external.label !== activeLabel) {
        microphoneStatus.textContent = `Джерело за даними браузера: ${activeLabel} (знайдено входів: ${devices.length}, зокрема «${external.label}»). Якщо пише телефон — виберіть «${external.label}» у списку вище або ввімкніть «Сирий звук».`;
    } else {
        microphoneStatus.textContent = `Джерело за даними браузера: ${activeLabel} (знайдено входів: ${devices.length}). Перевірте коротким записом, легко торкнувшись петлички.`;
    }
}

let microphoneUpdate = null;
async function updateMicrophone() {
    if (recordingStream) {
        microphoneStatus.textContent = "Спочатку зупиніть запис, потім оновіть мікрофони.";
        return;
    }
    if (microphoneUpdate) return microphoneUpdate;
    microphoneStatus.textContent = "Перезапускаємо камеру та аудіовхід…";
    microphoneUpdate = startCamera();
    try { await microphoneUpdate; }
    catch (_) { microphoneStatus.textContent = "Не вдалося вибрати мікрофон. Перевірте підключення та виберіть доступне джерело звуку."; }
    finally { microphoneUpdate = null; }
}
microphoneSelect.addEventListener("change", async () => {
    if (recordingStream) return;
    preferredMicrophone = microphoneSelect.value;
    try { localStorage.setItem("teleprompter-microphone", preferredMicrophone); } catch (_) {}
    await updateMicrophone();
});
document.querySelector("#refreshMicrophones").addEventListener("click", async () => {
    if (!stream) await startCamera();
    else await updateMicrophone();
});
navigator.mediaDevices?.addEventListener?.("devicechange", async () => {
    if (cameraStarting || !stream) return;
    if (recordingStream) {
        microphoneStatus.textContent = "Підключення змінилося. Зупиніть запис і натисніть «Перепідключити мікрофон».";
        return;
    }
    try {
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "audioinput");
        const signature = JSON.stringify(devices.map(device => [device.deviceId, device.label]));
        if (signature !== microphoneDeviceSignature) await updateMicrophone();
    } catch (_) { microphoneStatus.textContent = "Не вдалося перевірити мікрофони. Натисніть «Перепідключити мікрофон»."; }
});

async function checkMicrophoneAudio() {
    const result = document.querySelector("#audioCheckStatus");
    const button = document.querySelector("#checkAudio");
    const preview = document.querySelector("#audioCheckPlayback");
    if (recordingStream || cameraStarting || audioCheckRecorder) {
        result.textContent = "Зупиніть запис і дочекайтеся підключення камери.";
        return;
    }
    const track = stream?.getAudioTracks()[0];
    if (!track) { result.textContent = "Спочатку увімкніть камеру."; return; }
    if (track.readyState === "ended" || track.muted || track.enabled === false) {
        result.textContent = "Браузер не передає звук: аудіодоріжка вимкнена або перервана. Натисніть «Перепідключити мікрофон».";
        return;
    }
    if (typeof MediaRecorder === "undefined") { result.textContent = "Браузер не підтримує перевірку записом."; return; }
    let context = null, source = null, frame = null;
    const chunks = [];
    let peak = 0;
    let measured = false;
    let finished = false;
    const finish = async error => {
        if (finished) return;
        finished = true;
        if (frame !== null) cancelAnimationFrame(frame);
        source?.disconnect();
        if (context) { try { context.close().catch(() => {}); } catch (_) {} }
        audioCheckRecorder = null;
        button.disabled = false;
        if (error) { result.textContent = `Перевірка не вдалася: ${error.message}`; return; }
        const blob = new Blob(chunks, { type: chunks[0]?.type || "audio/mp4" });
        if (audioCheckUrl) URL.revokeObjectURL(audioCheckUrl);
        audioCheckUrl = URL.createObjectURL(blob);
        preview.src = audioCheckUrl;
        preview.hidden = false;
        const level = peak > 0 ? `${Math.round(20 * Math.log10(peak))} дБ` : "тиша";
        result.textContent = measured
            ? `Вхідний сигнал: ${level}. ${peak < 0.003 ? "Сигнал відсутній або дуже тихий." : "Сигнал надходить."} Прослухайте цей запис: він містить лише звук мікрофона, без відео. Перед прослуховуванням від’єднайте перехідник.`
            : "Записано звук мікрофона без відео. Перед прослуховуванням від’єднайте перехідник. Вимірювання рівня недоступне в цьому браузері.";
    };
    try {
        const input = new MediaStream([track]);
        const type = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find(value => MediaRecorder.isTypeSupported(value));
        const recorder = type ? new MediaRecorder(input, { mimeType: type }) : new MediaRecorder(input);
        audioCheckRecorder = recorder;
        button.disabled = true;
        preview.pause();
        preview.hidden = true;
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.onstop = () => { void finish(); };
        recorder.onerror = event => { void finish(event.error || new Error("Помилка аудіозапису")); };
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
            try {
                context = new AudioContextClass();
                // Do not await resume: some iOS PWAs leave that promise pending.
                context.resume().catch(() => {});
                source = context.createMediaStreamSource(input);
                const analyser = context.createAnalyser();
                analyser.fftSize = 2048;
                source.connect(analyser);
                const samples = new Float32Array(analyser.fftSize);
                const measure = () => {
                    if (context.state === "running") {
                        measured = true;
                        analyser.getFloatTimeDomainData(samples);
                        for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
                        document.querySelector("#audioInputLevel").value = Math.min(1, peak);
                    }
                    frame = requestAnimationFrame(measure);
                };
                measure();
            } catch (_) { /* Direct audio recording still works without Web Audio. */ }
        }
        result.textContent = "Перевірка: говоріть і легко торкніться петлички протягом 4 секунд…";
        recorder.start();
        setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 4000);
    } catch (error) { await finish(error); }
}
document.querySelector("#checkAudio").addEventListener("click", checkMicrophoneAudio);

function animate(timestamp) {
    if (!isPlaying) return;

    const elapsed = lastFrameTime === null ? 0 : Math.min(timestamp - lastFrameTime, 100);
    lastFrameTime = timestamp;
    progress += Number(speed.value) * 0.00016 * elapsed / (1000 / 60);
    updatePosition();

    if (progress >= 1) {
        stopPlaying();
        return;
    }

    animationFrame = requestAnimationFrame(animate);
}

function startPlaying() {
    if (isPlaying) stopPlaying();
    if (progress >= 1) progress = 0;
    isPlaying = true;
    playButton.textContent = "Ⅱ";
    playButton.setAttribute("aria-pressed", "true");
    playButton.setAttribute("aria-label", "Призупинити текст");
    lastFrameTime = null;
    animationFrame = requestAnimationFrame(animate);
}

function stopPlaying() {
    isPlaying = false;
    playButton.textContent = "▶";
    playButton.setAttribute("aria-pressed", "false");
    playButton.setAttribute("aria-label", "Запустити текст");
    if (animationFrame) cancelAnimationFrame(animationFrame);
}

function togglePlaying() {
    isPlaying ? stopPlaying() : startPlaying();
}

function closeEditor() {
    if (typeof editorDialog.close === "function") editorDialog.close();
    else editorDialog.removeAttribute("open");
}

document.querySelector("#editButton").addEventListener("click", () => {
    scriptInput.value = script;
    if (typeof editorDialog.showModal === "function") editorDialog.showModal();
    else editorDialog.setAttribute("open", "");
});

document.querySelector("#cancelEdit").addEventListener("click", () => {
    closeEditor();
});

document.querySelector("#saveEdit").addEventListener("click", () => {
    script = scriptInput.value.trim();
    if (!script) script = defaultScript;
    try {
        localStorage.setItem("teleprompter-script", script);
    } catch (error) {
        setStatus("Текст працює, але Safari не дозволив зберегти його. Після закриття сторінки він може втратитися.");
    }
    closeEditor();
    renderScript();
});

document.querySelector("#mirrorButton").addEventListener("click", () => {
    scriptText.classList.toggle("mirrored");
    document.querySelector("#mirrorButton").setAttribute("aria-pressed", String(scriptText.classList.contains("mirrored")));
    updatePosition();
});

document.querySelector("#cameraButton").addEventListener("click", async () => {
    if (recordingStream) return;
    currentFacingMode = currentFacingMode === "user" ? "environment" : "user";
    mirrorVideo = currentFacingMode === "user";
    flipVideoButton.setAttribute("aria-pressed", String(mirrorVideo));
    await startCamera();
});
connectCameraButton.addEventListener("click", startCamera);

speed.addEventListener("input", () => {
    document.querySelector("#speedValue").textContent = speed.value;
});
fontSize.addEventListener("input", renderScript);
opacity.addEventListener("input", renderScript);
for (const input of [speed, fontSize, opacity]) input.addEventListener("change", saveSettings);
playButton.addEventListener("click", togglePlaying);
restartButton.addEventListener("click", () => {
    stopPlaying();
    progress = 0;
    updatePosition();
});

function openSystemCamera() {
    if (recordingStream || cameraStarting || audioCheckRecorder) {
        setStatus("Спочатку зупиніть запис або перевірку звуку.");
        return;
    }
    stopPlaying();
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    camera.pause();
    camera.srcObject = null;
    if (cameraFrame !== null) cancelAnimationFrame(cameraFrame);
    cameraFrame = null;
    cameraView.classList.remove("active");
    cameraPlaceholder.classList.remove("hidden");
    try { if (navigator.audioSession) navigator.audioSession.type = "auto"; } catch (_) {}
    closePanel(document.querySelector("#settingsDialog"));
    const input = document.querySelector("#systemCameraInput");
    input.value = "";
    input.setAttribute("capture", currentFacingMode);
    setStatus("Зніміть відео в системній камері та підтвердьте його. Текст суфлера під час зйомки не відображається.");
    input.click();
}
function receiveSystemVideo() {
    const file = document.querySelector("#systemCameraInput").files?.[0];
    if (!file) { setStatus("Зйомку скасовано. Камеру суфлера можна ввімкнути знову."); return; }
    if (!file.size || (file.type && !file.type.startsWith("video/"))) {
        setStatus("Виберіть непорожній відеофайл.");
        return;
    }
    // Retain the original file and audio; never pass system-camera media
    // through getUserMedia, canvas or MediaRecorder.
    offerRecording(file, file.type || (/\.mov$/i.test(file.name) ? "video/quicktime" : "video/mp4"));
}
document.querySelector("#systemCameraButton").addEventListener("click", openSystemCamera);
document.querySelector("#systemCameraInput").addEventListener("change", receiveSystemVideo);
document.querySelector("#systemCameraInput").addEventListener("cancel", () => setStatus("Зйомку скасовано. Камеру суфлера можна ввімкнути знову."));

function restoreRecordingLayout() {
    recordingStartedAt = null;
    document.body.classList.remove("is-recording");
    recordButton.classList.remove("recording");
    recordButton.textContent = "● Записати";
    stopPlaying();
    updatePosition();
}

function offerRecording(blob, type) {
    if (!blob.size) {
        setStatus("Запис порожній. Спробуйте записати відео ще раз.");
        return;
    }
    const extension = type.includes("quicktime") ? "mov" : type.includes("mp4") ? "mp4" : "webm";
    const name = blob instanceof File ? blob.name : `teleprompter-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`;
    const file = blob instanceof File && blob.type ? blob : new File([blob], name, { type: type.split(";")[0] });
    const url = URL.createObjectURL(blob);
    const card = document.createElement("section");
    card.className = "recording-result";
    const preview = document.createElement("video");
    preview.controls = true;
    preview.playsInline = true;
    preview.src = url;
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Зберегти у Фото";
    const download = document.createElement("a");
    download.href = url;
    download.download = name;
    download.textContent = "Завантажити файл";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-recording";
    remove.textContent = "Видалити з історії";
    remove.addEventListener("click", () => {
        preview.pause();
        preview.removeAttribute("src");
        preview.load();
        URL.revokeObjectURL(url);
        card.remove();
        updateHistory();
        setStatus("Запис видалено з історії.");
    });
    const canShareFile = typeof navigator.share === "function" &&
        typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
    save.hidden = !canShareFile;
    save.addEventListener("click", async () => {
        save.disabled = true;
        remove.disabled = true;
        try {
            await navigator.share({ files: [file] });
            setStatus("Перевір збережене відео у «Фото».");
        } catch (error) {
            setStatus(error.name === "AbortError"
                ? "Збереження скасовано. Відео залишається доступним нижче."
                : "Не вдалося відкрити меню збереження. Спробуйте ще раз або завантажте файл.");
        } finally {
            save.disabled = false;
            remove.disabled = false;
        }
    });
    const hint = document.createElement("p");
    hint.textContent = canShareFile
        ? "У меню iPhone вибери «Зберегти відео»."
        : "Завантажте файл. На iPhone відкрийте його у «Файлах» → «Поширити» → «Зберегти відео», якщо цей формат підтримується. Збережіть запис перед закриттям додатка.";
    card.append(preview, save, download, hint, remove);
    document.querySelector("#recordings").prepend(card);
    updateHistory();
    openPanel(document.querySelector("#historyDialog"));
    setStatus("");
}

stopRecordingButton.addEventListener("click", () => {
    if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
});

recordButton.addEventListener("click", () => {
    if (audioCheckRecorder) { setStatus("Дочекайтеся завершення перевірки звуку."); return; }
    if (cameraStarting || microphoneUpdate) {
        setStatus("Зачекайте, завершується підключення мікрофона.");
        return;
    }
    if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
        return;
    }

    if (!stream) {
        setStatus("Натисніть «Увімкнути камеру». Якщо запит не з’являється, перевірте параметри вебсайту Safari та довіру до HTTPS-сертифіката.");
        return;
    }

    if (typeof MediaRecorder === "undefined") {
        setStatus("Запис відео не підтримується цим браузером.");
        return;
    }

    recordedChunks = [];
    const mimeType = ["video/mp4", "video/webm;codecs=vp8,opus", "video/webm"]
        .find(type => MediaRecorder.isTypeSupported(type));
    try {
        if (typeof cameraView.captureStream !== "function") throw new Error("Цей браузер не підтримує запис однакового зображення з переглядом.");
        drawCameraFrame();
        if (!camera.videoWidth || !camera.videoHeight) throw new Error("Дочекайтеся зображення камери.");
        recordingStream = cameraView.captureStream(30);
        recordingVideoTrack = recordingStream.getVideoTracks()[0];
        if (!recordingVideoTrack) throw new Error("Не вдалося підготувати відеопотік.");
        stream.getAudioTracks().forEach(track => recordingStream.addTrack(track));
        mediaRecorder = mimeType ? new MediaRecorder(recordingStream, { mimeType }) : new MediaRecorder(recordingStream);
    } catch (error) {
        releaseRecordingStream();
        setStatus(`Не вдалося почати запис: ${error.message}`);
        return;
    }
    mediaRecorder.ondataavailable = event => {
        if (event.data.size) recordedChunks.push(event.data);
    };
    mediaRecorder.onstop = () => {
        releaseRecordingStream();
        restoreRecordingLayout();
        const type = mediaRecorder.mimeType || (recordedChunks[0] && recordedChunks[0].type) || mimeType || "video/mp4";
        const blob = new Blob(recordedChunks, { type });
        offerRecording(blob, type);
        recordedChunks = [];
    };
    mediaRecorder.onerror = () => {
        releaseRecordingStream();
        restoreRecordingLayout();
        setStatus("Помилка запису відео. Спробуйте записати ще раз.");
    };

    try {
        mediaRecorder.start();
    } catch (error) {
        releaseRecordingStream();
        setStatus(`Не вдалося почати запис: ${error.message}`);
        return;
    }
    document.body.classList.add("is-recording");
    recordingStartedAt = Date.now();
    document.querySelector("#recordingTime").textContent = "00:00";
    flipVideoButton.disabled = true;
    rawAudioButton.disabled = true;
    microphoneSelect.disabled = true;
    recordButton.classList.add("recording");
    recordButton.textContent = "■ Стоп";
    progress = 0;
    updatePosition();
    startPlaying();
    setStatus("Йде запис відео.");
});

window.addEventListener("resize", updatePosition);

renderScript();
updateHistory();
