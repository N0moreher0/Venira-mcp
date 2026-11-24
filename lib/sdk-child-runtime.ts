/**
 * Child-side runtime of the JS SDK (ROADMAP_MINIMAL_MODE.md, Phase 3).
 *
 * `SDK_CHILD_PREAMBLE` is a ONE-LINE script prepended to every SDK snippet
 * (line 1 stays the preamble, so lib/js-executor.ts's stderr echo stripping
 * keeps working). It defines the frozen `venira` global that talks to the
 * parent over fd 3 (see lib/sdk-bridge.ts) and the help texts generated from
 * lib/sdk-registry.ts (R5: one registry, no second hand-maintained copy).
 *
 * SDK_FUNCTIONS is pinned 1:1 against SDK_API_CORE by scripts/test-sdk-bridge.ts.
 */
import { SDK_HELP_GROUPS, sdkHelpText, SDK_API_CORE } from "./sdk-registry.js";

/** Function names the runtime must implement (pinned against the registry). */
export const SDK_FUNCTIONS: readonly string[] = [...SDK_API_CORE.map((e) => e.name)];

type BridgeResponse = { id: number; ok: boolean; envelope?: Record<string, unknown>; error?: string; fatal?: boolean };

const HELP_JSON = JSON.stringify(Object.fromEntries(SDK_HELP_GROUPS.map((g) => [g.topic, sdkHelpText(g.topic)])));
const HELP_INDEX = JSON.stringify(sdkHelpText());

/**
 * One line. Uses the `require` shim the ESM preamble installs just before it.
 * Notes:
 *  - fd 3 is the bridge; fs.read/write on a numeric fd needs no path, so the
 *    Node permission model of the contained mode does not block it.
 *  - every bridge failure throws `[sdk_bridge*]` so the snippet (and the model)
 *    can tell transport problems from tool results.
 *  - type errors throw the exact expected signature (roadmap Phase 3).
 */
const SDK_PREAMBLE_STATEMENTS = [
  // ---- bridge plumbing over the Node IPC channel (stdio "ipc") ----
  // No fs/pipe juggling: the parent answers through process.send, the child
  // listens on "message". The channel does not keep the event loop alive, so
  // the snippet exits by itself when the user code is done.
  'const __vr_pending=new Map()',
  'let __vr_seq=0',
  'const __vr_req=(op,args)=>new Promise((res,rej)=>{const id=++__vr_seq;__vr_pending.set(id,{res,rej});__vr_arm(true);try{process.send({id,op,args})}catch(e){__vr_pending.delete(id);__vr_arm(false);rej(new Error("[sdk_bridge] send to the parent failed: "+(e&&e.message||e)))}})',
  `process.on("message",(m)=>{if(!m||typeof m!=="object")return;const p=__vr_pending.get(m.id);if(!p)return;__vr_pending.delete(m.id);__vr_arm(false);if(m.ok){p.res(m.envelope)}else{const e=new Error(m.error||"[sdk_bridge] the call failed");e.name=m.fatal?"VeniraPolicyError":"VeniraBridgeError";e.fatal=Boolean(m.fatal);e.envelope=m.envelope;p.rej(e)}})`,
  // The persistent "message" listener keeps the IPC channel referenced, which
  // would keep the child alive forever. Ref the channel only while a call is
  // in flight and drop the ref on settle, so the snippet exits by itself.
  `const __vr_arm=(v)=>{try{const ch=process.channel;if(v){ch.ref()}else{ch.unref()}}catch(e){}}`,
  "__vr_arm(false);",
  // ---- shared helpers ----
  `const __vr_call=async(op,args)=>await __vr_req(op,args===undefined?{}:args)`,
  `const __vr_sig=(want)=>new Error("Bad argument. Expected "+want+". Fix the call and rerun (the full contract is in the execute_js description).")`,
  `const __vr_isStr=(v)=>typeof v==="string"&&v.length>0`,
  `const __vr_obj=(v)=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v:null`,
];
/** Members of the object literal: separated by commas, not semicolons. */
const SDK_PREAMBLE_MEMBERS = [
  // read: string | (string|ReadItem)[]; single-string opts merge into the item,
  // array opts merge into every item (except max_response_bytes_per_item which is top-level).
  `async read(paths,opts){const isArr=Array.isArray(paths);if(!isArr&&!__vr_isStr(paths)&&__vr_obj(paths)===null)throw __vr_sig("venira.read(paths: string | (string | ReadItem)[], opts?)");const top={},per={};if(opts&&typeof opts==="object")for(const[k,v]of Object.entries(opts)){if(k==="max_response_bytes_per_item")top[k]=v;else per[k]=v}if(!isArr){if(__vr_isStr(paths))return await __vr_call("read_file",{relative_path:paths,...per});const single=__vr_obj(paths);if(!single)throw __vr_sig("venira.read(paths: string | (string | ReadItem)[], opts?) - each item must be a path string or a {relative_path, ...} object");return await __vr_call("read_file",{...per,...single,...top})}const items=paths.map((p)=>{if(__vr_isStr(p))return{relative_path:p,...per};const o=__vr_obj(p);if(!o)throw __vr_sig("venira.read(paths: string | (string | ReadItem)[], opts?) - each item must be a path string or a {relative_path, ...} object");return{...per,...o}});return await __vr_call("read_file",{requests:items,...top})}`,
  `async search(q,opts){const o=opts&&typeof opts==="object"?opts:{};if(Array.isArray(q)){const queries=q.map((x)=>__vr_isStr(x)?{pattern:x}:(__vr_obj(x)||(()=>{throw __vr_sig("venira.search(q: string | Queries, opts?)")})()));return await __vr_call("search",{queries,...o})}if(!__vr_isStr(q)&&__vr_obj(q)===null)throw __vr_sig("venira.search(q: string | Queries, opts?) - pass a query string or a queries[] array");if(typeof q==="string")return await __vr_call("search",{query:q,...o});return await __vr_call("search",{...q,...o})}`,
  `async list(path,opts){const o=opts&&typeof opts==="object"?opts:{};if(path!==undefined&&path!==null&&!__vr_isStr(path))throw __vr_sig("venira.list(path?: string, opts?)");return await __vr_call("list_files",path?{relative_path:path,...o}:{...o})}`,
  `async recent(limit){if(limit!==undefined&&typeof limit!=="number")throw __vr_sig("venira.recent(limit?: number)");return await __vr_call("recent_files",limit===undefined?{}:{limit})}`,
  `async info(path,opts){if(!__vr_isStr(path))throw __vr_sig("venira.info(path: string, opts?)");return await __vr_call("get_file_info",{relative_path:path,...(opts&&typeof opts==="object"?opts:{})})}`,
  `async outline(path,opts){if(!__vr_isStr(path))throw __vr_sig("venira.outline(path: string, opts?)");return await __vr_call("outline_symbol",{relative_path:path,...(opts&&typeof opts==="object"?opts:{})})}`,
  `async refs(symbol,opts){if(!__vr_isStr(symbol))throw __vr_sig("venira.refs(symbol: string, opts?)");return await __vr_call("symbol_references",{symbol_name:symbol,...(opts&&typeof opts==="object"?opts:{})})}`,
  `async diff(pathA,pathB,opts){if(!__vr_isStr(pathA)||!__vr_isStr(pathB))throw __vr_sig("venira.diff(pathA: string, pathB: string, opts?)");return await __vr_call("diff_files",{relative_path_a:pathA,relative_path_b:pathB,...(opts&&typeof opts==="object"?opts:{})})}`,
  `async write(path,content,reason,expectedSha256){if(!__vr_isStr(path)||typeof content!=="string")throw __vr_sig("venira.write(path: string, content: string, reason: string, expectedSha256?: string)");const args={relative_path:path,content,mode:"overwrite"};if(reason!==undefined)args.reason=reason;if(expectedSha256!==undefined)args.expected_sha256=expectedSha256;return await __vr_call("write_file",args)}`,
  `async edit(edits,reason,expectedSha256){const item=(e)=>{const o=__vr_obj(e);if(!o||!__vr_isStr(o.relative_path))throw __vr_sig("venira.edit(edits: Edit | Edit[], reason: string, expectedSha256?) - each Edit is { relative_path, old_text, new_text, ... }");return o};let args;if(Array.isArray(edits)){if(edits.length===0)throw __vr_sig("venira.edit(edits: Edit | Edit[], reason: string) - edits[] is empty");args={edits:edits.map(item)}}else{args=item(edits)}if(reason!==undefined)args.reason=reason;if(expectedSha256!==undefined)args.expected_sha256=expectedSha256;return await __vr_call("edit_file",args)}`,
  `async patch(diff,opts){if(!__vr_isStr(diff))throw __vr_sig("venira.patch(diff: string, opts?)");return await __vr_call("apply_patch",{patch:diff,...(opts&&typeof opts==="object"?opts:{})})}`,
  `async mkdir(path,opts){if(!__vr_isStr(path))throw __vr_sig("venira.mkdir(path: string, opts?)");return await __vr_call("create",{relative_path:path,...(opts&&typeof opts==="object"?opts:{})})}`,
  `async move(from,to,reason){if(!__vr_isStr(from)||!__vr_isStr(to))throw __vr_sig("venira.move(from: string, to: string, reason?)");const args={from,to};if(reason!==undefined)args.reason=reason;return await __vr_call("move_path",args)}`,
  `async copy(from,to,reason){if(!__vr_isStr(from)||!__vr_isStr(to))throw __vr_sig("venira.copy(from: string, to: string, reason?)");const args={from,to};if(reason!==undefined)args.reason=reason;return await __vr_call("copy_path",args)}`,
  `async remove(path,reason){if(!__vr_isStr(path))throw __vr_sig("venira.remove(path: string, reason: string)");return await __vr_call("delete_path",{relative_path:path,reason})}`,
  // shell: one or many commands through the FULL shell_run pipeline; sequential
  // so the audit trail keeps script order. Returns one envelope per command.
  `async shell(cmd,opts){const one=(c)=>{if(__vr_isStr(c))return{command:c,...(opts&&typeof opts==="object"?opts:{})};const o=__vr_obj(c);if(!o||!__vr_isStr(o.command))throw __vr_sig("venira.shell(cmd: string | ShellReq | ShellReq[], opts?) - each ShellReq is { command, ...shell_run args }");return{...(opts&&typeof opts==="object"?opts:{}),...o}};if(Array.isArray(cmd)){if(cmd.length===0)throw __vr_sig("venira.shell(cmd: string | ShellReq | ShellReq[], opts?) - cmd[] is empty");const out=[];for(const c of cmd){out.push(await __vr_call("shell_run",one(c)))}return out}return await __vr_call("shell_run",one(cmd))}`,
  `async shellStatus(runId,opts){if(!__vr_isStr(runId))throw __vr_sig("venira.shellStatus(runId: string, opts?)");const o=opts&&typeof opts==="object"?opts:{};if(o.action==="cancel"){if(!__vr_isStr(o.killKey))throw __vr_sig("venira.shellStatus(runId, { action: \\"cancel\\", killKey }) - killKey (from venira.shell) is required to cancel");return await __vr_call("cancel",{run_id:runId,kill_key:o.killKey})}const args={run_id:runId};if(o.wait_seconds!==undefined)args.wait_seconds=o.wait_seconds;return await __vr_call("shell_status",args)}`,
  `async snapshot(action,opts){const ok=["create","list","restore","delete","mirror"];if(!ok.includes(action))throw __vr_sig("venira.snapshot(action: \\"create\\" | \\"list\\" | \\"restore\\" | \\"delete\\" | \\"mirror\\", opts?)");return await __vr_call("snapshot",{action,...(opts&&typeof opts==="object"?opts:{})})}`,
  `async git(action,args){const ok=["status","diff","log","branch","commit","stash","push"];if(!ok.includes(action))throw __vr_sig("venira.git(action: \\"status\\" | \\"diff\\" | \\"log\\" | \\"branch\\" | \\"commit\\" | \\"stash\\" | \\"push\\", args?)");const rest=args&&typeof args==="object"?{...args}:{};const payload={action,...rest};if(action==="branch"||action==="stash"){payload.action=typeof rest.sub==="string"&&rest.sub.trim()?rest.sub:"list"}return await __vr_call("git_"+action,payload)}`,
  `async memory(action,content,ifVersion){if(action!=="read"&&action!=="write")throw __vr_sig("venira.memory(action: \\"read\\" | \\"write\\", content?, ifVersion?)");const args={action};if(action==="write"){if(typeof content!=="string"||!content.trim())throw __vr_sig("venira.memory(\\"write\\", content: string, ifVersion?) - content (the full note) is required");args.content=content;if(ifVersion!==undefined)args.if_version=ifVersion}return await __vr_call("memory",args)}`,
  `async graph(opts){return await __vr_call("dependency_graph",opts&&typeof opts==="object"?opts:{})}`,
  `help(topic){if(topic===undefined)return ${HELP_INDEX};const key=String(topic).trim().toLowerCase();const text=${HELP_JSON};return text[key]||("Unknown topic: "+JSON.stringify(topic)+". Topics: "+Object.keys(text).join(", "))}`,
  `async raw(op,args){if(!__vr_isStr(op))throw __vr_sig("venira.raw(op: string, args?)");return await __vr_call(op,args===undefined?{}:args)}`,
];

export const SDK_CHILD_PREAMBLE = [
  SDK_PREAMBLE_STATEMENTS.join(";"),
  `const venira={${SDK_PREAMBLE_MEMBERS.join(",")}}`,
  "Object.freeze(venira)",
].join(";") + ";";

if (SDK_CHILD_PREAMBLE.includes("\n")) {
  // Guard the one-line invariant the stderr echo stripping relies on.
  throw new Error("SDK_CHILD_PREAMBLE must stay a single line");
}

/** The exact global the contract promises. Used by the pin test. */
export const SDK_GLOBAL_NAME = "venira";

export type { BridgeResponse };
