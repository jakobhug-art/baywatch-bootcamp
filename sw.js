// Baywatch Bootcamp release __BOOTCAMP_VERSION__
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));

self.addEventListener('message',event=>{
 if(event.data==='bootcamp-activate') event.waitUntil(self.skipWaiting());
});

self.addEventListener('fetch',event=>{
 if(event.request.mode!=='navigate'||new URL(event.request.url).origin!==self.location.origin) return;
 event.respondWith(fetch(event.request,{cache:'no-cache'}).catch(()=>new Response(`<!doctype html>
 <html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
 <title>Baywatch Bootcamp · Offline</title><h1>Du bist offline</h1><p>Verbinde dich mit dem Internet, um dein Workout zu öffnen.</p>
 <a href="">Erneut laden</a></html>`,{status:503,headers:{'Content-Type':'text/html; charset=utf-8'}})));
});
