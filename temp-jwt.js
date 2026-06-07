const crypto = require("crypto");
const secret = "audit_local_jwt_secret_do_not_use_in_prod_0123456789abcdef0123456789";
const header = { alg: "HS256", typ: "JWT" };
const payload = { sub: "a727521b-8fb4-4631-983b-f1864f574c88", provider: "GUEST", email: null, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600, sid: crypto.randomBytes(16).toString("hex") };
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64").replace(/=+$/g,"").replace(/\+/g,'-').replace(/\//g,'_');
const headerB64 = b64(header);
const payloadB64 = b64(payload);
const sig = crypto.createHmac("sha256", secret).update(headerB64 + "." + payloadB64).digest("base64").replace(/=+$/g,"").replace(/\+/g,'-').replace(/\//g,'_');
console.log(`${headerB64}.${payloadB64}.${sig}`);
