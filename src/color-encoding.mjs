// SPDX-License-Identifier: MIT
export const signature=bytes=>bytes?.length>=20?String.fromCharCode(bytes[16],bytes[17],bytes[18],bytes[19]):null;
export function nativeEncoding(h,icc=h.icc) {
  const encoding={...h.colorEncoding};
  if(encoding.wantICC&&icc){
    encoding.iccSpace=signature(icc);encoding.transferFunction='icc';
    if(icc.length>=68)encoding.renderingIntent=new DataView(icc.buffer,icc.byteOffset,icc.byteLength).getUint32(64);
    delete encoding.transferId;delete encoding.gamma;delete encoding.whitePoint;delete encoding.whitePointId;delete encoding.primaries;delete encoding.primariesId;
    if(encoding.iccSpace==='CMYK'){encoding.space='cmyk';encoding.invertedCMYK=true;}
  }
  return encoding;
}
