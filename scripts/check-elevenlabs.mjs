// No real credentials, network calls or audio device required.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
function compile(file, source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")) {
  const result = ts.transpileModule(source, {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  assert.equal(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0, file);
  return result.outputText;
}
function load(code, imports = {}) {
  const mod = { exports: {} };
  new Function("module", "exports", "require", code)(mod, mod.exports, id => id in imports ? imports[id] : require(id));
  return mod.exports;
}
const storage = readFileSync(new URL("../lib/settings-storage.ts", import.meta.url), "utf8");
const bindingStart = storage.indexOf("export function resolveBinding(");
const bindingEnd = storage.indexOf("\n/**", bindingStart);
const { resolveBinding } = load(compile("binding.ts", storage.slice(bindingStart, bindingEnd)));
const eleven = { id: "eleven", provider: "ElevenLabs", apiKey: "fake-key", defaultVoice: "voice123", enableTTS: true };
const openai = { id: "openai", provider: "OpenAI", apiKey: "fake-openai", defaultVoice: "alloy" };
const minimax = { id: "minimax", provider: "Minimax", apiKey: "fake-minimax", defaultVoice: "male-qn-qingse" };
const { resolveVoiceConfig, synthesizeSpeech, prepareVoiceText } = load(compile("lib/tts-service.ts"), {
  "./settings-storage": {
    loadVoiceConfigs: () => [eleven, minimax, openai],
    loadBindingConfig: () => ({ globalDefaults: { voiceConfigId: "openai" }, characterBindings: [
      { characterId: "a", defaults: { voiceConfigId: "eleven" }, appOverrides: { vn: { voiceConfigId: "minimax" } } },
    ] }),
    resolveBinding,
  },
});
assert.equal(resolveVoiceConfig("a"), eleven);
assert.equal(resolveVoiceConfig("another"), openai);
assert.equal(resolveVoiceConfig("a", "vn"), minimax);

const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  if (url.includes("/t2a_v2")) return Response.json({ data: { audio: "494433" } });
  return new Response(Uint8Array.from([73, 68, 51]), { headers: { "Content-Type": "audio/mpeg" } });
};
assert.equal(await synthesizeSpeech(" ", eleven), null);
await assert.rejects(synthesizeSpeech("你好", { ...eleven, apiKey: " " }), /API Key/);
await assert.rejects(synthesizeSpeech("你好", { ...eleven, defaultVoice: " " }), /Voice ID/);
assert.equal(calls.length, 0);
const audio = await synthesizeSpeech("你好", resolveVoiceConfig("a"));
assert.equal(audio.type, "audio/mpeg");
assert.deepEqual([...new Uint8Array(await audio.arrayBuffer())], [73, 68, 51]);
assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/text-to-speech/voice123?output_format=mp3_44100_128");
assert.equal(calls[0].init.headers["xi-api-key"], "fake-key");
assert.equal(calls[0].init.redirect, "error");
assert.deepEqual(JSON.parse(calls[0].init.body), { text: "你好", model_id: "eleven_multilingual_v2" });
await synthesizeSpeech("hello", { ...eleven, model: "eleven_v3" });
assert.equal(JSON.parse(calls[1].init.body).model_id, "eleven_v3");
assert.equal((await synthesizeSpeech("hello", openai)).type, "audio/mpeg");
assert.match(calls[2].url, /audio\/speech$/);
assert.equal((await synthesizeSpeech("hello", minimax)).type, "audio/mpeg");
assert.match(calls[3].url, /t2a_v2$/);
const spoken = "{voice:quietly} 嗯……{voice:soft chuckle} 你呀。";
for (const model of ["eleven_v3", "eleven_v4", "eleven_v4_turbo"]) {
  await synthesizeSpeech(spoken, { ...eleven, model });
  assert.equal(JSON.parse(calls.at(-1).init.body).text, "[quietly] 嗯……[soft chuckle] 你呀。");
}
await synthesizeSpeech(spoken, { ...eleven, model: "eleven_multilingual_v2" });
assert.equal(JSON.parse(calls.at(-1).init.body).text, " 嗯…… 你呀。");
await synthesizeSpeech(spoken, openai);
assert.equal(JSON.parse(calls.at(-1).init.body).input, " 嗯…… 你呀。");
await synthesizeSpeech(spoken, minimax);
assert.equal(JSON.parse(calls.at(-1).init.body).text, " 嗯…… 你呀。");
assert.equal(prepareVoiceText("{voice:无效}你好 {ordinary}", { ...eleven, model: "eleven_v4" }), "你好 {ordinary}");
assert.equal(await synthesizeSpeech("{voice:quietly}", { ...eleven, model: "eleven_multilingual_v2" }), null);

const { parseAIResponse } = load(compile("lib/rich-message-parser.ts"), {
  "./state-value-parser": load(compile("lib/state-value-parser.ts")),
  "./action-parser": { stripActionShells: text => text },
  "./text-tool-protocol": load(compile("lib/text-tool-protocol.ts")),
  "./custom-app-chat-directives": { loadCustomAppChatDirectives: () => [] },
});
const voiceParts = parseAIResponse(`[语音条:${spoken}]`, []).parts;
assert.equal(voiceParts.length, 1);
assert.equal(voiceParts[0].mediaType, "audio");
assert.equal(voiceParts[0].mediaData.label, spoken);
await synthesizeSpeech(voiceParts[0].mediaData.label, { ...eleven, model: "eleven_v4" });
assert.equal(JSON.parse(calls.at(-1).init.body).text, "[quietly] 嗯……[soft chuckle] 你呀。");
const callParts = parseAIResponse(spoken, []).parts;
assert.equal(callParts.length, 1);
assert.equal(callParts[0].content, spoken);
globalThis.fetch = async () => new Response("denied", { status: 401 });
await assert.rejects(synthesizeSpeech("hello", eleven), /401/);
globalThis.fetch = async () => Response.json({ detail: { status: "voice_not_found", message: "Voice missing" } }, { status: 400 });
await assert.rejects(synthesizeSpeech("hello", eleven), /400.*voice_not_found.*Voice missing/);
globalThis.fetch = async () => Response.json({ detail: { code: "invalid_request", message: "Invalid fake-key" } }, { status: 400 });
await assert.rejects(synthesizeSpeech("hello", eleven), error => error.message.includes("invalid_request") && !error.message.includes("fake-key"));
globalThis.fetch = async () => Response.json({ detail: [{ msg: "Invalid model" }] }, { status: 422 });
await assert.rejects(synthesizeSpeech("hello", eleven), /422.*Invalid model/);
globalThis.fetch = async () => Response.json({ message: "not audio" });
await assert.rejects(synthesizeSpeech("hello", eleven), /有效音频/);

compile("components/settings/voice-settings.tsx");
console.log("PASS: ElevenLabs TTS request, audio, validation/errors, character binding cascade, OpenAI/MiniMax regression and TSX syntax.");
