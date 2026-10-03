"use strict";
const fs=require("fs"), path=require("path"), crypto=require("crypto");
const days=Math.max(1,Number(process.argv[2]||30)); const subject=String(process.argv[3]||"customer");
const privateKey=crypto.createPrivateKey(fs.readFileSync(path.join(__dirname,"..","tools-license-private.pem")));
const payload=Buffer.from(JSON.stringify({licenseId:`lic_${Date.now().toString(36)}`,subject,expiresAt:new Date(Date.now()+days*86400000).toISOString()})).toString("base64url");
const signature=crypto.sign(null,Buffer.from(payload),privateKey).toString("base64url");
const out={payload,signature}; fs.writeFileSync(path.join(process.cwd(),"license.json"),JSON.stringify(out,null,2)+"\n"); console.log(`已生成 license.json，有效期 ${days} 天`);
