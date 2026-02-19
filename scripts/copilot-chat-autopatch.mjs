#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const PATCH_MARKER = "/* local-qwen-copilot-autopatch:v12 */";
const PATCH_MARKER_V1 = "/* local-qwen-copilot-autopatch:v1 */";
const PATCH_MARKER_V2 = "/* local-qwen-copilot-autopatch:v2 */";
const PATCH_MARKER_V3 = "/* local-qwen-copilot-autopatch:v3 */";
const PATCH_MARKER_V4 = "/* local-qwen-copilot-autopatch:v4 */";
const PATCH_MARKER_V5 = "/* local-qwen-copilot-autopatch:v5 */";
const PATCH_MARKER_V6 = "/* local-qwen-copilot-autopatch:v6 */";
const PATCH_MARKER_V7 = "/* local-qwen-copilot-autopatch:v7 */";
const PATCH_MARKER_V8 = "/* local-qwen-copilot-autopatch:v8 */";
const PATCH_MARKER_V9 = "/* local-qwen-copilot-autopatch:v9 */";
const PATCH_MARKER_V10 = "/* local-qwen-copilot-autopatch:v10 */";
const PATCH_MARKER_V11 = "/* local-qwen-copilot-autopatch:v11 */";
const ALL_PATCH_MARKERS = [
  PATCH_MARKER_V1,
  PATCH_MARKER_V2,
  PATCH_MARKER_V3,
  PATCH_MARKER_V4,
  PATCH_MARKER_V5,
  PATCH_MARKER_V6,
  PATCH_MARKER_V7,
  PATCH_MARKER_V8,
  PATCH_MARKER_V9,
  PATCH_MARKER_V10,
  PATCH_MARKER_V11,
  PATCH_MARKER,
];

function resolveExtensionRoots() {
  const env = process.env.COPILOT_EXTENSIONS_DIRS;
  if (env && env.trim()) {
    return env
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [
    path.join(os.homedir(), ".vscode", "extensions"),
    path.join(os.homedir(), ".cursor", "extensions"),
  ];
}

async function listCopilotChatInstallations() {
  const roots = resolveExtensionRoots();
  const found = [];

  for (const root of roots) {
    let entries = [];
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (!entry.name.startsWith("github.copilot-chat-")) {
        continue;
      }

      const extensionJs = path.join(root, entry.name, "dist", "extension.js");
      try {
        await fsp.access(extensionJs);
        found.push(extensionJs);
      } catch {
        // ignore
      }
    }
  }

  return found;
}

function ensureBackup(filePath) {
  const backupPath = `${filePath}.local-qwen-autopatch.bak`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
  }
}

function readBackupIfExists(filePath) {
  const backupPath = `${filePath}.local-qwen-autopatch.bak`;
  if (!fs.existsSync(backupPath)) {
    return undefined;
  }
  return fs.readFileSync(backupPath, "utf8");
}

function applyPatch(content) {
  if (content.includes(PATCH_MARKER)) {
    return { patched: false, reason: "already-patched-v5", content };
  }

  const modelInfoReturnAnchor =
    "return this._currentModels=o,this._chatEndpoints=c,o";
  const chatResponseOld =
    "async _provideLanguageModelChatResponse(t,r,a,o,s){let c=this._chatEndpoints.find(l=>l.model===MD.resolveAlias(t.id));if(!c)throw new Error(`Endpoint not found for model ${t.id}`);return this._lmWrapper.provideLanguageModelResponse(c,r,{...a,modelOptions:a.modelOptions},a.requestInitiator,o,s)}";
  const tokenCountOld =
    "async _provideTokenCount(t,r,a){let o=this._chatEndpoints.find(s=>s.model===MD.resolveAlias(t.id));if(!o)throw new Error(`Endpoint not found for model ${t.id}`);return this._lmWrapper.provideTokenCount(o,r)}";
  const editAgentIntentOld =
    "getIntentHandlerOptions(t){return{maxToolCallIterations:UD(t)??this.instantiationService.invokeFunction(vM),temperature:this.configurationService.getConfig(G.Advanced.AgentTemperature)??0,overrideRequestLocation:7,hideRateLimitTimeEstimate:!0}}";
  const edit2IntentOld =
    "getIntentHandlerOptions(t){return{maxToolCallIterations:UD(t)??this.instantiationService.invokeFunction(vM),temperature:this.configurationService.getConfig(G.Advanced.AgentTemperature)??0,overrideRequestLocation:5}}";
  const coreEndpointOld =
    'async getChatEndpoint(e){if(this._logService.trace("Resolving chat model"),this._overridenChatModel)return this._logService.trace("Using overriden chat model"),this.getOrCreateChatEndpointInstance({id:this._overridenChatModel,name:"Custom Overriden Chat Model",version:"1.0.0",model_picker_enabled:!0,is_chat_default:!1,is_chat_fallback:!1,capabilities:{supports:{streaming:!0},tokenizer:"o200k_base",family:"custom",type:"chat"}});let t;if(typeof e=="string"){let r=await this._modelFetcher.getChatModelFromFamily(e);t=this.getOrCreateChatEndpointInstance(r)}else{let r="model"in e?e.model:e;if(r&&r.vendor==="copilot"&&r.id===Uu.pseudoModelId)try{let a=await this.getAllChatEndpoints();return this._autoModeService.resolveAutoModeEndpoint(e,a)}catch{return this.getChatEndpoint("copilot-base")}else if(r&&r.vendor==="copilot"){let a=await this._modelFetcher.getChatModelFromApiModel(r);t=a?this.getOrCreateChatEndpointInstance(a):await this.getChatEndpoint("copilot-base")}else r?t=this._instantiationService.createInstance(VB,r):t=await this.getChatEndpoint("copilot-base")}return this._logService.trace("Resolved chat model"),t}';
  const customProviderEndpointOld =
    'async getChatEndpoint(e){let t=!!this._configService.getConfig(G.Shared.DebugOverrideCAPIUrl)||!!this._configService.getConfig(G.Shared.DebugOverrideProxyUrl);if(this._authService.copilotToken?.isNoAuthUser&&!t){let r=async()=>{let s=(await fwr.lm.selectChatModels()).find(c=>c.vendor!=="copilot");if(s)return this._logService.trace("Using custom contributed chat model"),this._instantiationService.createInstance(VB,s);throw new Error("No custom contributed chat models found.")};if(typeof e=="string"||("model"in e?e.model:e).vendor==="copilot")return r()}return super.getChatEndpoint(e)}';

  if (!content.includes(modelInfoReturnAnchor)) {
    return { patched: false, reason: "model-info-anchor-missing", content };
  }
  if (!content.includes(chatResponseOld)) {
    return { patched: false, reason: "chat-response-anchor-missing", content };
  }
  if (!content.includes(tokenCountOld)) {
    return { patched: false, reason: "token-count-anchor-missing", content };
  }
  if (!content.includes(editAgentIntentOld)) {
    return {
      patched: false,
      reason: "edit-agent-intent-anchor-missing",
      content,
    };
  }
  if (!content.includes(edit2IntentOld)) {
    return {
      patched: false,
      reason: "edit2-intent-anchor-missing",
      content,
    };
  }
  if (!content.includes(coreEndpointOld)) {
    return {
      patched: false,
      reason: "core-endpoint-anchor-missing",
      content,
    };
  }
  if (!content.includes(customProviderEndpointOld)) {
    return {
      patched: false,
      reason: "custom-provider-endpoint-anchor-missing",
      content,
    };
  }

  const modelInfoInjected = [
    "try{",
    'let LQ=(await fr.lm.selectChatModels({vendor:"local-ollama"}));',
    'if(!LQ.length){let LQ2=(await fr.lm.selectChatModels({vendor:"ollama"}));for(let M2 of LQ2)LQ.push(M2)}',
    "let LSEEN=new Set;",
    "for(let M of LQ){",
    'let LKEY=((M.name??M.id??"")+"").toLowerCase();',
    'if(!LKEY||LSEEN.has(LKEY)||o.some(N=>((N.name??N.id??"")+"").toLowerCase()===LKEY))continue;',
    "LSEEN.add(LKEY);",
    'let LMN=(M.name??"").toLowerCase(),LMF=(M.family??"").toLowerCase();',
    'let LIV=LMN.includes("vl")||LMN.includes("vision")||LMF.includes("vl")||LMF.includes("vision");',
    'let LTOOL=!(LMN.includes("instruct")&&LMN.includes("tiny"));',
    'let LDETAIL=fr.l10n.t("Local Ollama{0}{1}",LIV?" · vision":"",LTOOL?" · tools":"");',
    'o.push({id:M.id,name:M.name,family:M.family,tooltip:M.tooltip??fr.l10n.t("Local model from vendor {0}","ollama"),multiplier:void 0,detail:LDETAIL,category:{label:fr.l10n.t("Local Models"),order:3},statusIcon:void 0,version:M.version,maxInputTokens:M.maxInputTokens,maxOutputTokens:Math.max(1024,Math.floor(M.maxInputTokens/3)),requiresAuthorization:void 0,isDefault:{[zd.Panel]:!1,[zd.Terminal]:!1,[zd.Notebook]:!1,[zd.Editor]:!1},isUserSelectable:!0,capabilities:{imageInput:LIV,toolCalling:LTOOL}})',
    "}",
    "}catch{}",
    modelInfoReturnAnchor,
  ].join("");

  const chatResponseNew = [
    "async _provideLanguageModelChatResponse(t,r,a,o,s){",
    'let LPREF=(process?.env?.COPILOT_LOCAL_MODEL??(fr.workspace.getConfiguration().get("github.copilot.chat.implementAgent.model")??"")).toLowerCase();',
    'let LID=(t.id??"").toLowerCase(),LNAME=(t.name??"").toLowerCase();',
    'let LALL=[...(await fr.lm.selectChatModels({vendor:"local-ollama"}))];',
    'if(!LALL.length)LALL=[...(await fr.lm.selectChatModels({vendor:"ollama"}))];',
    "let LUNIQ=[];for(let M of LALL){if(!LUNIQ.some(N=>N.id===M.id))LUNIQ.push(M)}",
    'if(!LUNIQ.length)throw new Error("[local-qwen-autopatch] no local models available; refusing Copilot fallback");',
    'let LSELECT=LUNIQ.find(u=>(u.id??"").toLowerCase()===LID||(u.name??"").toLowerCase()===LID||(u.id??"").toLowerCase()===LNAME||(u.name??"").toLowerCase()===LNAME);',
    'let LFORCE=LUNIQ.find(u=>(u.id??"").toLowerCase()===LPREF||(u.name??"").toLowerCase()===LPREF);',
    "let LTARGET=LSELECT??LFORCE??LUNIQ[0];",
    'if(LTARGET){try{console.warn("[local-qwen-autopatch] routing request to local model",LTARGET.id,LTARGET.name,"for",t.id,t.name??"")}catch{}',
    'let LTXT="";for(let z=r.length-1;z>=0;z--){let m=r[z];if(m.role===fr.LanguageModelChatMessageRole.User){LTXT=(m.content??[]).map(p=>p instanceof fr.LanguageModelTextPart?p.value:"").join(" ").toLowerCase();if(LTXT)break}}',
    "let LQ=LTXT.split(/[^a-z0-9_]+/).filter(w=>w.length>2);",
    'let LS=(a.tools??[]).map(u=>{let D=((u.name??"")+" "+(u.description??"")).toLowerCase();let S=0;for(let w of LQ)D.includes(w)&&(S+=1);return{u,S}}).sort((x,y)=>y.S-x.S||((x.u.name??"").localeCompare(y.u.name??""))).map(x=>x.u);',
    "let LBASE=LS.length?LS:(a.tools??[]);",
    'let LTOOLS=LBASE.slice(0,18).map(u=>({name:u.name,description:(u.description??"").slice(0,180),inputSchema:u.inputSchema}));',
    "let LRESP=await LTARGET.sendRequest(r,{modelOptions:a.modelOptions,tools:LTOOLS,toolMode:a.toolMode},s);",
    "let first = true; for await(let d of LRESP.stream){ if(first && d.text){ d.text = `(LOCAL QWEN: ${LTARGET.name||LTARGET.id}) ` + d.text; first = false; } o.report(d); }",
    "return",
    "}",
    "throw new Error(`[local-qwen-autopatch] no local routing target for model ${t.id}; fallback disabled`)",
    "}",
  ].join("");

  const tokenCountNew = [
    "async _provideTokenCount(t,r,a){",
    'let LPREF=(process?.env?.COPILOT_LOCAL_MODEL??(fr.workspace.getConfiguration().get("github.copilot.chat.implementAgent.model")??"")).toLowerCase();',
    'let LID=(t.id??"").toLowerCase(),LNAME=(t.name??"").toLowerCase();',
    'let LALL=[...(await fr.lm.selectChatModels({vendor:"local-ollama"}))];',
    'if(!LALL.length)LALL=[...(await fr.lm.selectChatModels({vendor:"ollama"}))];',
    "let LUNIQ=[];for(let M of LALL){if(!LUNIQ.some(N=>N.id===M.id))LUNIQ.push(M)}",
    'if(!LUNIQ.length)throw new Error("[local-qwen-autopatch] no local models available for token count");',
    'let LSELECT=LUNIQ.find(u=>(u.id??"").toLowerCase()===LID||(u.name??"").toLowerCase()===LID||(u.id??"").toLowerCase()===LNAME||(u.name??"").toLowerCase()===LNAME);',
    'let LFORCE=LUNIQ.find(u=>(u.id??"").toLowerCase()===LPREF||(u.name??"").toLowerCase()===LPREF);',
    "let LTARGET=LSELECT??LFORCE??LUNIQ[0];",
    "if(LTARGET)return LTARGET.countTokens(r);",
    "throw new Error(`[local-qwen-autopatch] no local token-count target for model ${t.id}; fallback disabled`)",
    "}",
  ].join("");

  const editAgentIntentNew =
    "getIntentHandlerOptions(t){return{maxToolCallIterations:UD(t)??this.instantiationService.invokeFunction(vM),temperature:this.configurationService.getConfig(G.Advanced.AgentTemperature)??0,overrideRequestLocation:7,hideRateLimitTimeEstimate:!0}}";
  const edit2IntentNew =
    "getIntentHandlerOptions(t){return{maxToolCallIterations:UD(t)??this.instantiationService.invokeFunction(vM),temperature:this.configurationService.getConfig(G.Advanced.AgentTemperature)??0,overrideRequestLocation:5}}";
  const coreEndpointNew =
    'async getChatEndpoint(e){if(this._logService.trace("Resolving chat model"),this._overridenChatModel)return this._logService.trace("Using overriden chat model"),this.getOrCreateChatEndpointInstance({id:this._overridenChatModel,name:"Custom Overriden Chat Model",version:"1.0.0",model_picker_enabled:!0,is_chat_default:!1,is_chat_fallback:!1,capabilities:{supports:{streaming:!0},tokenizer:"o200k_base",family:"custom",type:"chat"}});try{let LREQ=typeof e==="string"?e:("model"in e?e.model:e),LM=(await fr.lm.selectChatModels()).filter(m=>m.vendor!=="copilot");if(LM.length){if(typeof LREQ==="string"){let LI=LREQ.toLowerCase(),LP=(process?.env?.COPILOT_LOCAL_MODEL??(fr.workspace.getConfiguration().get("github.copilot.chat.implementAgent.model")??"")).toLowerCase(),LF=LM.find(m=>(m.id??"").toLowerCase()===LI||(m.name??"").toLowerCase()===LI||(m.family??"").toLowerCase()===LI||(m.id??"").toLowerCase().includes(LI)||(m.name??"").toLowerCase().includes(LI));LF=LF??(LP?LM.find(m=>(m.id??"").toLowerCase()===LP||(m.name??"").toLowerCase()===LP):void 0)??LM[0];if(LF)return console.warn("[local-qwen-autopatch] core endpoint force-route",LF.id,LF.name,"requested",LREQ),this._instantiationService.createInstance(VB,LF)}else if(LREQ&&LREQ.vendor!=="copilot")return console.warn("[local-qwen-autopatch] core endpoint force-route",LREQ.id,LREQ.name),this._instantiationService.createInstance(VB,LREQ)}}catch{}let t;if(typeof e=="string"){let r=await this._modelFetcher.getChatModelFromFamily(e);t=this.getOrCreateChatEndpointInstance(r)}else{let r="model"in e?e.model:e;if(r&&r.vendor==="copilot"&&r.id===Uu.pseudoModelId)try{let a=await this.getAllChatEndpoints();return this._autoModeService.resolveAutoModeEndpoint(e,a)}catch{return this.getChatEndpoint("copilot-base")}else if(r&&r.vendor==="copilot"){let a=await this._modelFetcher.getChatModelFromApiModel(r);t=a?this.getOrCreateChatEndpointInstance(a):await this.getChatEndpoint("copilot-base")}else r?t=this._instantiationService.createInstance(VB,r):t=await this.getChatEndpoint("copilot-base")}return this._logService.trace("Resolved chat model"),t}';

  const customProviderEndpointNew =
    'async getChatEndpoint(e){try{let LM=(await fwr.lm.selectChatModels()).filter(c=>c.vendor!=="copilot");if(LM.length){let L=(typeof e==="string"?e:("model"in e?e.model:e)),LI=typeof L==="string"?L.toLowerCase():"",LP=(process?.env?.COPILOT_LOCAL_MODEL??(fwr.workspace.getConfiguration().get("github.copilot.chat.implementAgent.model")??"")).toLowerCase();let LF=LI?LM.find(c=>(c.id??"").toLowerCase()===LI||(c.name??"").toLowerCase()===LI||(c.family??"").toLowerCase()===LI||(c.id??"").toLowerCase().includes(LI)||(c.name??"").toLowerCase().includes(LI)):void 0;LF=LF??(LP?LM.find(c=>(c.id??"").toLowerCase()===LP||(c.name??"").toLowerCase()===LP):void 0)??LM[0];if(LF)return console.warn("[local-qwen-autopatch] force routing to contributed model",LF.id,LF.name),this._instantiationService.createInstance(VB,LF)}}catch{}let t=!!this._configService.getConfig(G.Shared.DebugOverrideCAPIUrl)||!!this._configService.getConfig(G.Shared.DebugOverrideProxyUrl);if(this._authService.copilotToken?.isNoAuthUser&&!t){let r=async()=>{let s=(await fwr.lm.selectChatModels()).find(c=>c.vendor!=="copilot");if(s)return this._logService.trace("Using custom contributed chat model"),this._instantiationService.createInstance(VB,s);throw new Error("No custom contributed chat models found.")};if(typeof e=="string"||("model"in e?e.model:e).vendor==="copilot")return r()}return super.getChatEndpoint(e)}';

  let next = content;
  next = next.replace(modelInfoReturnAnchor, modelInfoInjected);
  next = next.replace(chatResponseOld, chatResponseNew);
  next = next.replace(tokenCountOld, tokenCountNew);
  next = next.replace(editAgentIntentOld, editAgentIntentNew);
  next = next.replace(edit2IntentOld, edit2IntentNew);
  next = next.replace(coreEndpointOld, coreEndpointNew);
  next = next.replace(customProviderEndpointOld, customProviderEndpointNew);

  if (next === content) {
    return { patched: false, reason: "no-op-replacement", content };
  }

  next = `${PATCH_MARKER}\n${next}`;
  return { patched: true, reason: "patched", content: next };
}

export async function autopatchCopilotChat(options = {}) {
  const force = Boolean(options.force);
  const files = await listCopilotChatInstallations();
  const results = [];

  for (const filePath of files) {
    const current = await fsp.readFile(filePath, "utf8");
    const hasAnyPatch = ALL_PATCH_MARKERS.some((marker) =>
      current.includes(marker),
    );
    if (!force && current.includes(PATCH_MARKER)) {
      results.push({ filePath, patched: false, reason: "already-patched-v5" });
      continue;
    }

    const baseContent = hasAnyPatch
      ? (readBackupIfExists(filePath) ?? current)
      : current;
    const { patched, reason, content } = applyPatch(baseContent);

    if (patched) {
      ensureBackup(filePath);
      await fsp.writeFile(filePath, content, "utf8");
    }

    results.push({
      filePath,
      patched,
      reason: hasAnyPatch ? `${reason}-from-existing` : reason,
    });
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const force = process.argv.includes("--force");
  autopatchCopilotChat({ force })
    .then((results) => {
      if (results.length === 0) {
        console.log("[autopatch] No github.copilot-chat installations found.");
        process.exit(1);
      }

      for (const result of results) {
        console.log(
          `[autopatch] ${result.patched ? "patched" : "skipped"} ${result.filePath} (${result.reason})`,
        );
      }

      const anyPatched = results.some((entry) => entry.patched);
      if (!anyPatched) {
        console.log(
          "[autopatch] Nothing patched. If this is a new Copilot version, patch anchors likely changed.",
        );
      }
    })
    .catch((error) => {
      console.error("[autopatch] Failed:", error);
      process.exit(1);
    });
}
