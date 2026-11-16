const chatDate=new Intl.DateTimeFormat('de-DE',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Berlin'});

export function setupGroupChat(api){
 const openers=document.querySelectorAll('[data-chat-open]');
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
 const messages=new Map();
 let firstMessage;
 let pinnedId;
 let draft;
 let timer;
 let loadNumber=0;
 let writing=false;
 let drawn='';

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
  const ordered=[...messages.values()].sort((a,b)=>a.messageId.length-b.messageId.length||a.messageId.localeCompare(b.messageId));
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
   if(older||!messages.size) firstMessage=data.messages.length===40?data.messages[0].messageId:undefined;
   for(const message of data.messages) messages.set(message.messageId,message);
   render(data.pinned,{bottom,older});
  }catch(error){
   if(!quiet&&request===loadNumber&&account?.id===owner) showStatus(error.message);
  }finally{if(request===loadNumber) more.disabled=false;}
 }

 function openChat(){
  if(!account||dialog.open) return;
  showStatus();
  dialog.showModal();
  load({bottom:true});
  clearInterval(timer);
  timer=setInterval(()=>{if(!document.hidden&&!writing&&!more.disabled) load({quiet:true});},8000);
 }
 for(const opener of openers) opener.addEventListener('click',openChat);
 dialog.querySelector('#chat-close').addEventListener('click',()=>dialog.close());
 dialog.addEventListener('close',()=>{if(!dialog.open) clearInterval(timer);});
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
  if(user?.id!==account?.id){
   if(dialog.open) dialog.close();
   loadNumber++;
   messages.clear();
   list.replaceChildren();
   pinned.replaceChildren();
   pinned.hidden=more.hidden=empty.hidden=true;
   firstMessage=draft=undefined;
   drawn='';
   form.reset();
   showStatus();
  }
  account=user;
 };
}
