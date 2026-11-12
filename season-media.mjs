const crcTable=Uint32Array.from({length:256},(_,byte)=>{
 let value=byte;
 for(let bit=0;bit<8;bit++) value=(value>>>1)^((value&1)?0xedb88320:0);
 return value;
});

function crc32(bytes){
 let value=0xffffffff;
 for(const byte of bytes) value=(value>>>8)^crcTable[(value^byte)&255];
 return (value^0xffffffff)>>>0;
}

// Media files are already compressed. Store them in the ZIP without recompressing.
export function seasonZip(files){
 const encoder=new TextEncoder();
 const records=[];
 const directory=[];
 let offset=0;
 let directorySize=0;
 for(const {filename,bytes} of files){
  const name=encoder.encode(filename);
  const crc=crc32(bytes);
  const header=new DataView(new ArrayBuffer(30));
  const entry=new DataView(new ArrayBuffer(46));
  header.setUint32(0,0x04034b50,true);
  header.setUint16(4,20,true);
  header.setUint16(6,0x800,true);
  header.setUint16(12,33,true);
  header.setUint32(14,crc,true);
  header.setUint32(18,bytes.length,true);
  header.setUint32(22,bytes.length,true);
  header.setUint16(26,name.length,true);
  entry.setUint32(0,0x02014b50,true);
  entry.setUint16(4,20,true);
  entry.setUint16(6,20,true);
  entry.setUint16(8,0x800,true);
  entry.setUint16(14,33,true);
  entry.setUint32(16,crc,true);
  entry.setUint32(20,bytes.length,true);
  entry.setUint32(24,bytes.length,true);
  entry.setUint16(28,name.length,true);
  entry.setUint32(42,offset,true);
  records.push(header,name,bytes);
  directory.push(entry,name);
  offset+=header.byteLength+name.length+bytes.length;
  directorySize+=entry.byteLength+name.length;
 }
 if(files.length>65535 || offset+directorySize>0xffffffff){
  throw new Error('Die Season ist zu groß für eine ZIP-Datei.');
 }
 const end=new DataView(new ArrayBuffer(22));
 end.setUint32(0,0x06054b50,true);
 end.setUint16(8,files.length,true);
 end.setUint16(10,files.length,true);
 end.setUint32(12,directorySize,true);
 end.setUint32(16,offset,true);
 return new Blob([...records,...directory,end],{type:'application/zip'});
}

export async function makeWorkoutPhoto(file){
 let image;
 const url=URL.createObjectURL(file);
 try{
  image=new Image();
  image.src=url;
  await image.decode();
 }catch{
  throw new Error('Dieses Bildformat konnte nicht geöffnet werden. Wähle ein JPEG, PNG oder WebP.');
 }finally{URL.revokeObjectURL(url);}
 const canvas=document.createElement('canvas');
 const scale=Math.min(1,960/Math.max(image.naturalWidth,image.naturalHeight));
 canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));
 canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
 const context=canvas.getContext('2d',{alpha:false});
 context.fillStyle='#fff';
 context.fillRect(0,0,canvas.width,canvas.height);
 context.drawImage(image,0,0,canvas.width,canvas.height);
 for(const quality of [.83,.7,.57,.44,.32,.22]){
  const jpeg=canvas.toDataURL('image/jpeg',quality);
  if(jpeg.startsWith('data:image/jpeg;base64,') && jpeg.length<=213355) return jpeg.split(',')[1];
 }
 throw new Error('Das Foto lässt sich nicht weit genug verkleinern. Wähle ein anderes Bild.');
}
