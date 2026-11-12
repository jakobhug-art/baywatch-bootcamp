// MediaRecorder's streaming WebM can report a wrong duration in native audio controls.
// Decode short voice clips and give the player a WAV with an explicit sample count.
export async function voiceForPlayback(recording){
 const Decoder=globalThis.OfflineAudioContext||globalThis.webkitOfflineAudioContext;
 if(!Decoder) return recording;
 let audio;
 try{
  audio=await new Decoder(1,1,48000).decodeAudioData(await recording.arrayBuffer());
 }catch{
  return recording;
 }
 if(!audio.length || audio.duration>30) return recording;

 const channels=Math.min(2,audio.numberOfChannels);
 const tracks=Array.from({length:channels},(_,channel)=>audio.getChannelData(channel));
 const bytesPerFrame=channels*2;
 const dataSize=audio.length*bytesPerFrame;
 const wav=new ArrayBuffer(44+dataSize);
 const header=new DataView(wav);
 header.setUint32(0,0x52494646); // RIFF
 header.setUint32(4,36+dataSize,true);
 header.setUint32(8,0x57415645); // WAVE
 header.setUint32(12,0x666d7420); // fmt
 header.setUint32(16,16,true);
 header.setUint16(20,1,true); // PCM
 header.setUint16(22,channels,true);
 header.setUint32(24,audio.sampleRate,true);
 header.setUint32(28,audio.sampleRate*bytesPerFrame,true);
 header.setUint16(32,bytesPerFrame,true);
 header.setUint16(34,16,true);
 header.setUint32(36,0x64617461); // data
 header.setUint32(40,dataSize,true);
 for(let sample=0,offset=44;sample<audio.length;sample++){
  for(const track of tracks){
   const value=Math.max(-1,Math.min(1,track[sample]));
   header.setInt16(offset,value*(value<0?32768:32767),true);
   offset+=2;
  }
 }
 return new Blob([wav],{type:'audio/wav'});
}
