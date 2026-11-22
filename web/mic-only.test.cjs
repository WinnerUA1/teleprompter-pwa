const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const script = fs.readFileSync(__dirname + '/mic-only.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const elements = {};
const element = () => ({ children: [], textContent: '', pause() {}, append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) {this.children=nodes;}, add(node){this.children.push(node);} });
for (const id of ['input','status','report','list','record','profile','all','playback','results']) elements['#'+id] = element();
elements['#input'].value = 'usb';
elements['#input'].selectedOptions = [{text:'USBAudio1.0'}];
elements['#profile'].options = ['default','raw','mono44100','mono48000'].map(value=>({value,text:value}));
const requests = [], inputs = [];
let active = 0, stopped = 0;
const context = {
    document: { querySelector: id=>elements[id], createElement: element },
    window: {isSecureContext:true}, Blob, Option: class {constructor(text,value){this.text=text;this.value=value;}},
    URL: {createObjectURL: ()=>'blob:recording',revokeObjectURL() {}},
    setTimeout(fn) { fn(); },
    navigator: {mediaDevices: {async getUserMedia(constraints) {
        assert.equal(active,0,'Only one microphone may be open');
        assert.equal(constraints.video,false,'No camera in the isolation test');
        requests.push(constraints);
        if (constraints.audio.sampleRate?.exact===48000) {
            const error = new Error('Invalid constraint'); error.name='OverconstrainedError'; error.constraint='sampleRate'; throw error;
        }
        active++;
        const track = {label:'USBAudio1.0',readyState:'live',muted:false,getSettings:()=>({deviceId:'usb'}),stop(){active--;stopped++;}};
        return {getAudioTracks:()=>[track],getTracks:()=>[track]};
    }}},
    MediaRecorder: class {
        static isTypeSupported(){return true;}
        constructor(stream){inputs.push(stream);this.mimeType='audio/mp4';}
        start(){this.state='recording';}
        stop(){this.state='inactive';this.ondataavailable({data:new Blob(['audio'])});this.onstop();}
    }
};
(async()=>{
    vm.createContext(context);vm.runInContext(script,context);
    await elements['#all'].onclick();
    assert.equal(requests.length,4);
    assert(requests.every(r=>r.audio.deviceId.exact==='usb'));
    assert.equal(requests[1].audio.echoCancellation.exact,false);
    assert.equal(requests[2].audio.channelCount.exact,1);
    assert.equal(requests[2].audio.sampleRate.exact,44100);
    assert.equal(stopped,3);
    assert.equal(inputs.length,3);
    assert.equal(elements['#results'].children.length,4,'Keep successful samples and parameter-specific failure');
    assert.match(elements['#results'].children[3].textContent,/sampleRate/);
    assert.equal(elements['#all'].disabled,false);
    requests.length=0;
    context.navigator.mediaDevices.enumerateDevices=async()=>[{kind:'audioinput',deviceId:'usb',label:'USBAudio1.0'}];
    await elements['#list'].onclick();
    assert.equal(requests.length,0,'Listing known USB input must not require a default-microphone request');
    assert.equal(elements['#input'].value,'usb');
    let enumeration=0;
    context.navigator.mediaDevices.enumerateDevices=async()=>++enumeration===1 ? [] : [{kind:'audioinput',deviceId:'usb',label:'USBAudio1.0'}];
    context.navigator.mediaDevices.getUserMedia=async()=>{const error=new Error('Invalid constraint');error.name='OverconstrainedError';throw error;};
    await elements['#list'].onclick();
    assert.match(elements['#report'].textContent,/USBAudio1.0/);
    assert.match(elements['#report'].textContent,/Invalid constraint/);
    assert.equal(elements['#record'].disabled,false,'Failed default input cannot hide or disable a discovered external input');
    console.log('PASS: isolated USB profile comparison, strict constraints, sequential track cleanup, unsupported-format report');
})().catch(error=>{console.error(error);process.exitCode=1;});
