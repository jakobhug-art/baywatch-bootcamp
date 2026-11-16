const chatDate=new Intl.DateTimeFormat('de-DE',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Berlin'});
const pageSize=40;
const compareIds=(a,b)=>a.length-b.length||a.localeCompare(b);

export function setupGroupChat(api){
 const openers=document.querySelectorAll('[data-chat-open]');
 const menuButton=document.querySelector('#chat-open');
 const badge=document.querySelector('#chat-unread');
 const dialog=document.querySelector('#chat-dialog');
 const pinned=dialog.querySelector('.chat-pinned');
 const thread=dialog.querySelector('.chat-thread');
 const list=dialog.querySelector('.chat-messages');
 const status=dialog.querySelector('.chat-status');
 const empty=dialog.querySelector('#chat-empty');
 const more=dialog.querySelector('#chat-more');
 const form=dialog.querySelector('#chat-form');
 const input=form.elements.message;
 const send=form.querySelector('button');
 let account;
 let unread;
 const messages=new Map();
 let firstMessage;
 let pinnedId;
 let draft;
 let timer;
 let loadNumber=0;
 let writing=false;
 let drawn='';

 function renderUnread(count){
  badge.hidden=!count;
  badge.textContent=count>99?'99+':count||'';
  if(count) menuButton.setAttribute('aria-label',`Chat, ${count} ${count===1?'ungelesene Nachricht':'ungelesene Nachrichten'}`);
  else menuButton.removeAttribute('aria-label');
 }

 function readCursor(key){
  try{
   const value=localStorage.getItem(key);
   if(value&&/^\d+$/.test(value)) return value;
  }catch{}
 }

 function markRead(id){
  const stored=readCursor(unread.key);
  const seen=[id,unread.seen,stored].filter(Boolean).sort(compareIds).at(-1);
  unread.seen=unread.checked=seen;
  unread.count=0;
  renderUnread(0);
  try{if(seen!==stored) localStorage.setItem(unread.key,seen);}catch{}
 }

 async function checkUnread(){
  const current=unread;
  if(!current||current.checking||dialog.open||document.hidden) return;
  const checked=current.checked;
  const handle=account.handle;
  const isCurrent=()=>unread===current&&current.checked===checked&&!dialog.open&&!document.hidden;
  current.checking=true;
  try{
   let {messages:page}=await api('chat');
   if(!isCurrent()) return;
   const latest=page.at(-1)?.messageId||'0';
   if(checked===undefined){markRead(latest);return;}
   if(compareIds(latest,checked)<=0) return;
   let count=0;
   while(true){
    count+=page.filter(message=>message.author!==handle&&compareIds(message.messageId,checked)>0).length;
    if(page.length<pageSize||compareIds(page[0].messageId,checked)<=0) break;
    ({messages:page}=await api('chat?before='+page[0].messageId));
    if(!isCurrent()) return;
   }
   current.checked=latest;
   current.count+=count;
   renderUnread(current.count);
  }catch{
   // Keep the current badge when the connection drops. The next poll retries.
  }finally{current.checking=false;}
 }

 window.addEventListener('storage',event=>{
  if(!unread||event.key!==unread.key||!/^\d+$/.test(event.newValue||'')) return;
  if(unread.seen!==undefined&&compareIds(event.newValue,unread.seen)<=0) return;
  unread.seen=unread.checked=event.newValue;
  unread.count=0;
  renderUnread(0);
  if(!unread.checking) checkUnread();
 });

 function showStatus(message=''){
  status.textContent=message;
  status.hidden=!message;
 }

 function pinButton(message,isPinned){
  const button=document.createElement('button');
  button.type='button';
  button.textContent=isPinned?'Anheftung lösen':'Anheften';
  button.addEventListener('click',async()=>{
   if(writing||!account?.admin) return;
   const owner=account.id;
   writing=true;
   button.disabled=true;
   showStatus();
   try{
    await api('chat/pin',{id:message.messageId,pin:!isPinned});
    if(account?.id===owner) await load();
   }catch(error){if(account?.id===owner) showStatus(error.message);}
   finally{writing=false;button.disabled=false;}
  });
  return button;
 }

 function render(announcement,{bottom,older}){
  const oldHeight=thread.scrollHeight;
  const oldTop=thread.scrollTop;
  const nearBottom=oldHeight-thread.clientHeight-oldTop<48;
  const ordered=[...messages.values()].sort((a,b)=>compareIds(a.messageId,b.messageId));
  const signature=JSON.stringify([Boolean(account.admin),announcement?.messageId,ordered.map(({messageId})=>messageId)]);
  if(signature!==drawn){
   drawn=signature;
   pinnedId=announcement?.messageId;
   pinned.replaceChildren();
   pinned.hidden=!announcement;
   if(announcement){
    const title=document.createElement('strong');
    title.textContent='Angeheftet · '+announcement.author;
    const text=document.createElement('p');
    text.textContent=announcement.body;
    pinned.append(title,text);
    if(account.admin) pinned.append(pinButton(announcement,true));
   }
   list.replaceChildren(...ordered.map(message=>{
    const row=document.createElement('li');
    row.className=message.author===account.handle?'chat-message own':'chat-message';
    const header=document.createElement('header');
    const author=document.createElement('strong');
    author.textContent=message.author;
    const time=document.createElement('time');
    time.dateTime=message.createdAt;
    time.textContent=chatDate.format(new Date(message.createdAt));
    header.append(author,time);
    const text=document.createElement('p');
    text.textContent=message.body;
    row.append(header,text);
    if(account.admin) row.append(pinButton(message,message.messageId===pinnedId));
    return row;
   }));
  }
  empty.hidden=Boolean(ordered.length);
  more.hidden=!firstMessage;
  if(older) thread.scrollTop=oldTop+thread.scrollHeight-oldHeight;
  else if(bottom||nearBottom) thread.scrollTop=thread.scrollHeight;
 }

 async function load({older=false,bottom=false,quiet=false}={}){
  const owner=account?.id;
  if(!owner||!dialog.open || older&&!firstMessage) return;
  const request=++loadNumber;
  more.disabled=true;
  try{
   const data=await api(older?'chat?before='+firstMessage:'chat');
   if(request!==loadNumber||account?.id!==owner||!dialog.open) return;
   if(older||!messages.size) firstMessage=data.messages.length===pageSize?data.messages[0].messageId:undefined;
   for(const message of data.messages) messages.set(message.messageId,message);
   render(data.pinned,{bottom,older});
   if(!older&&!document.hidden) markRead(data.messages.at(-1)?.messageId||'0');
  }catch(error){
   if(!quiet&&request===loadNumber&&account?.id===owner) showStatus(error.message);
  }finally{if(request===loadNumber) more.disabled=false;}
 }

 function openChat(){
  if(!account||dialog.open) return;
  showStatus();
  dialog.showModal();
  load({bottom:true});
 }
 function refreshChat(){
  if(!account||document.hidden) return;
  if(!dialog.open) checkUnread();
  else if(!writing&&!more.disabled) load({quiet:true});
 }
 for(const opener of openers) opener.addEventListener('click',openChat);
 document.addEventListener('visibilitychange',refreshChat);
 window.addEventListener('online',refreshChat);
 dialog.querySelector('#chat-close').addEventListener('click',()=>dialog.close());
 dialog.addEventListener('close',()=>{if(!dialog.open) checkUnread();});
 more.addEventListener('click',()=>load({older:true}));
 form.addEventListener('submit',async event=>{
  event.preventDefault();
  const owner=account?.id;
  const body=input.value.trim();
  if(!owner||!body||writing) return;
  if(draft?.body!==body) draft={body,requestId:crypto.randomUUID()};
  const message=draft;
  writing=true;
  send.disabled=true;
  showStatus();
  try{
   await api('chat',message);
   if(account?.id!==owner) return;
   if(input.value.trim()===body) input.value='';
   draft=undefined;
   await load({bottom:true});
  }catch(error){if(account?.id===owner) showStatus(error.message);}
  finally{send.disabled=false;writing=false;}
 });

 return user=>{
  for(const opener of openers) opener.hidden=!user;
  const changed=user?.id!==account?.id;
  account=user;
  if(changed){
   if(dialog.open) dialog.close();
   clearInterval(timer);
   loadNumber++;
   messages.clear();
   list.replaceChildren();
   pinned.replaceChildren();
   pinned.hidden=more.hidden=empty.hidden=true;
   firstMessage=draft=undefined;
   drawn='';
   form.reset();
   showStatus();
   unread=undefined;
   renderUnread(0);
   if(user){
    const key='bootcamp-chat-read:'+user.id;
    const seen=readCursor(key);
    unread={key,seen,checked:seen,count:0};
    checkUnread();
    timer=setInterval(refreshChat,10000);
   }
  }
 };
}
