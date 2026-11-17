// Baywatch Bootcamp release __BOOTCAMP_VERSION__
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));

self.addEventListener('message',event=>{
 if(event.data==='bootcamp-activate') event.waitUntil(self.skipWaiting());
 if(event.data==='bootcamp-push-ready') event.ports[0]?.postMessage(true);
});

self.addEventListener('push',event=>{
 let data;
 try{data=event.data?.json();}catch{}
 const notification=self.registration.showNotification('Baywatch Bootcamp',{
  body:data?.body||'Du hast eine neue Nachricht von Bootcamp.',
  icon:new URL('./bootcamp-brandung-192.png',self.registration.scope).href,
  tag:data?.tag,
  data:{url:data?.url}
 });
 event.waitUntil(notification.then(async()=>{
  if(data?.kind!=='test') return;
  const windows=await self.clients.matchAll({type:'window'});
  for(const client of windows) client.postMessage({type:'bootcamp-push-test-received',tag:data.tag});
 }));
});

self.addEventListener('notificationclick',event=>{
 event.notification.close();
 const route=event.notification.data?.url;
 const hash=['#rangliste','#heute','#profil','#chat'].includes(route)?route:'#start';
 const target=new URL(hash,self.registration.scope);
 event.waitUntil((async()=>{
  const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  for(const client of windows){
   if(!client.url.startsWith(self.registration.scope)) continue;
   const destination=client.url===target.href?client:await client.navigate(target.href);
   if(destination){await destination.focus();return;}
  }
  await self.clients.openWindow(target.href);
 })());
});

self.addEventListener('fetch',event=>{
 if(event.request.mode!=='navigate'||new URL(event.request.url).origin!==self.location.origin) return;
 event.respondWith(fetch(event.request,{cache:'no-cache'}).catch(()=>new Response(`<!doctype html>
 <html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
 <title>Baywatch Bootcamp · Offline</title><h1>Du bist offline</h1><p>Verbinde dich mit dem Internet, um dein Workout zu öffnen.</p>
 <a href="">Erneut laden</a></html>`,{status:503,headers:{'Content-Type':'text/html; charset=utf-8'}})));
});
