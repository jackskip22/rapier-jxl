// SPDX-License-Identifier: MIT
export const signature=bytes=>bytes?.length>=20?String.fromCharCode(...bytes.subarray(16,20)):null;
export function nativeEncoding(h,icc=h.icc) {
  const encoding={...h.colorEncoding};
  if(encoding.wantICC&&icc){
    encoding.iccSpace=signature(icc);encoding.transferFunction='icc';
    if(icc.length>=68){const intent=icc.subarray(64,68);encoding.renderingIntent=new DataView(intent.buffer,intent.byteOffset,intent.byteLength).getUint32(0);}
    delete encoding.transferId;delete encoding.gamma;delete encoding.whitePoint;delete encoding.whitePointId;delete encoding.primaries;delete encoding.primariesId;
    if(encoding.iccSpace==='CMYK'){encoding.space='cmyk';encoding.invertedCMYK=true;}
  }
  return encoding;
}
