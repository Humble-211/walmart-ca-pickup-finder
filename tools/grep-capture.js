const fs=require("fs");
const lines=fs.readFileSync("walmart-capture.jsonl","utf8").trim().split("\n").map(l=>JSON.parse(l));
const s=lines.map(e=>e.response?.body||"").join("\n");
for(const k of ["FF_PICKUP","PICKUP_INSTORE","Pickup today","checkItemAvailability","itemAvailability","availabilityInNearbyStore","nearbyStore","storeAvailability"]) console.log(k, s.split(k).length-1);
const re=/"usItemId":"(\d{10,})"[\s\S]{0,4000}?"key":"(FF_PICKUP[A-Z_]*)"/g; let m; const ids=new Set();
while((m=re.exec(s))&&ids.size<10) ids.add(m[1]+" "+m[2]);
console.log([...ids]);
