# SPDX-License-Identifier: MIT
# Extract original metadata segments from a pinned public ExifTool sample corpus.
# python3 prepare-phone-metadata.py OUTPUT [--download]
from pathlib import Path
import tarfile,json,hashlib,struct,argparse,urllib.request,base64,gzip,contextlib
parser=argparse.ArgumentParser()
parser.add_argument('output',nargs='?',default=str(Path(__file__).resolve().parent))
parser.add_argument('--download',action='store_true')
parser.add_argument('--fixtures',help='Replay pinned gzip/base64 sample records without a network archive download')
args=parser.parse_args();root=Path(args.output).resolve();root.mkdir(parents=True,exist_ok=True)
archives={
 'Apple':{'bytes':513946,'sha256':'289b342ace0c89f2d04fe7aab9721640804d61a1e392700087870d96186c3546'},
 'Google':{'bytes':1440884,'sha256':'5b2a0dad42710d6f51aba413c96df6e4527bf8b9c2c3fb60df9554a0ddab9489'},
 'Samsung':{'bytes':16956319,'sha256':'1a3c3a5d5f9cdeac203755c7f6e25a5a43ab14d3a3a526eb8bc3aa11bcd89bc7'}
}
fixtureSamples={}
if args.fixtures:
    fixture=json.loads(Path(args.fixtures).read_text())
    for sample in fixture['samples']:
        if not 0<sample['bytes']<=1048576:raise ValueError('Fixture sample size exceeds corpus bound')
        data=gzip.decompress(base64.b64decode(sample['gzipBase64'],validate=True))
        if len(data)!=sample['bytes'] or hashlib.sha256(data).hexdigest()!=sample['sha256']:raise ValueError('Fixture checksum mismatch')
        if sample['member'] in fixtureSamples:raise ValueError('Duplicate fixture sample')
        fixtureSamples[sample['member']]=data
for make,record in archives.items():
    record.update({'name':make,'url':'https://exiftool.org/'+make+'.tar.gz'})
    path=root/(make+'.tar.gz')
    if args.download and not path.exists():
        request=urllib.request.Request(record['url'],headers={'User-Agent':'Rapier-JXL-metadata-proof'})
        with urllib.request.urlopen(request,timeout=30) as response:data=response.read(record['bytes']+1)
        if len(data)!=record['bytes'] or hashlib.sha256(data).hexdigest()!=record['sha256']:
            raise ValueError('Public archive no longer matches the pinned corpus: '+make)
        path.write_bytes(data)
    if not path.exists() and not fixtureSamples:raise FileNotFoundError(str(path)+'; provide the pinned archive or use --download')
selection={
 'Apple':['Apple_iPhone12Pro.jpg','Apple_iPhone14.jpg','Apple_iPhone15Pro.jpg','Apple_iPhone16Pro.jpg'],
 'Google':['GooglePixel6a.jpg','GooglePixel8Pro.jpg','GooglePixel9Pro.jpg','GooglePixel10ProXL.jpg'],
 'Samsung':['SamsungGalaxyA15.jpg','SamsungGalaxyA55_5G.jpg','SamsungGalaxyS23Ultra.jpg','SamsungGalaxyS25Ultra.jpg']
}
hash=lambda b:hashlib.sha256(b).hexdigest()

def segments(jpeg):
    if jpeg[:2]!=b'\xff\xd8':raise ValueError('Not JPEG')
    at=2
    while at<len(jpeg):
        if jpeg[at]!=255:raise ValueError('Expected JPEG marker')
        start=at
        while at<len(jpeg) and jpeg[at]==255:at+=1
        marker=jpeg[at];at+=1
        if marker in (0xda,0xd9):break
        if marker==1 or 0xd0<=marker<=0xd8:continue
        length=int.from_bytes(jpeg[at:at+2],'big')
        if length<2 or at+length>len(jpeg):raise ValueError('Invalid JPEG segment')
        yield marker,start,jpeg[at+2:at+length]
        at+=length

def tags(tiff):
    endian='<' if tiff[:2]==b'II' else '>' if tiff[:2]==b'MM' else None
    if not endian or struct.unpack_from(endian+'H',tiff,2)[0]!=42:raise ValueError('Invalid TIFF')
    off=struct.unpack_from(endian+'I',tiff,4)[0]
    count=struct.unpack_from(endian+'H',tiff,off)[0]
    found={}
    for k in range(count):
        at=off+2+12*k;tag,typ,n,value=struct.unpack_from(endian+'HHII',tiff,at)
        if tag in (271,272,305) and typ==2:
            data=tiff[at+8:at+8+n] if n<=4 else tiff[value:value+n]
            found[{271:'make',272:'model',305:'software'}[tag]]=data.rstrip(b'\0').decode('utf8',errors='replace')
    return found

manifest={'name':'Phone Metadata v1','selection':'Four named phone samples from each of the Apple, Google and Samsung public metadata archives; deliberate device diversity, not a population-weighted survey.',
 'sourcePage':'https://exiftool.org/sample_images.html','sourcePageMirror':'https://github.com/exiftool/exiftool/blob/master/html/sample_images.html',
 'provenance':'ExifTool replaces main image data and removes material after JPEG EOI, preserving original APP metadata segments. The source cautions that some contributions may have passed through other software. These measurements concern metadata, not complete original photographs.',
 'archives':[],'rows':[]}
(root/'samples').mkdir(exist_ok=True);(root/'payloads').mkdir(exist_ok=True)
for make,names in selection.items():
    ar=archives[make]
    if not fixtureSamples:
        archiveBytes=(root/(make+'.tar.gz')).read_bytes()
        assert hash(archiveBytes)==ar['sha256']
    manifest['archives'].append({k:ar[k] for k in ['name','url','bytes','sha256']})
    with (contextlib.nullcontext(None) if fixtureSamples else tarfile.open(root/(make+'.tar.gz'),'r:gz')) as archive:
        for name in names:
            member=make+'/'+name;data=fixtureSamples[member] if fixtureSamples else archive.extractfile(member).read()
            (root/'samples'/name).write_bytes(data)
            extensions={}; jumbf={}
            row={'name':name[:-4],'archive':make,'member':member,'sourceBytes':len(data),'sourceSha256':hash(data),'metadata':[],'otherApps':[],'extendedXmpFragments':[]}
            for marker,offset,payload in segments(data):
                kind=None;raw=None
                if marker==0xe1 and payload.startswith(b'Exif\0\0'):
                    kind='exif';raw=payload[6:]; row['device']=tags(raw)
                elif marker==0xe1 and payload.startswith(b'http://ns.adobe.com/xap/1.0/\0'):
                    kind='xmp';raw=payload[len(b'http://ns.adobe.com/xap/1.0/\0'):]
                elif marker==0xe1 and payload.startswith(b'http://ns.adobe.com/xmp/extension/\0'):
                    prefix=len(b'http://ns.adobe.com/xmp/extension/\0')
                    guid=payload[prefix:prefix+32].decode('ascii'); full,partOffset=struct.unpack_from('>II',payload,prefix+32)
                    part=payload[prefix+40:]
                    if full>16777216 or partOffset+len(part)>full:raise ValueError('Extended XMP bounds')
                    if guid not in extensions:extensions[guid]={'length':full,'parts':[]}
                    if extensions[guid]['length']!=full:raise ValueError('Extended XMP size differs')
                    extensions[guid]['parts'].append((partOffset,part))
                    row['extendedXmpFragments'].append({'offset':offset,'bytes':len(payload),'sha256':hash(payload),'guid':guid,'fullBytes':full,'partOffset':partOffset,'partBytes':len(part)})
                elif marker==0xeb and payload.startswith(b'JP'):
                    instance,sequence,boxLength=struct.unpack_from('>HII',payload,2)
                    boxType=payload[12:16]; boxHeader=16 if boxLength==1 else 8
                    if boxLength==1:boxLength=struct.unpack_from('>Q',payload,16)[0]
                    if boxType!=b'jumb' or boxLength<boxHeader or boxLength>16777216:raise ValueError('Unsupported JUMBF sample framing')
                    key=(instance,boxType)
                    if key not in jumbf:jumbf[key]={'length':boxLength,'header':payload[8:8+boxHeader],'parts':{}}
                    item=jumbf[key]
                    if item['length']!=boxLength or sequence<1 or sequence in item['parts']:raise ValueError('JUMBF sequence mismatch')
                    item['parts'][sequence]=payload[8+boxHeader:]
                    row['otherApps'].append({'marker':marker,'offset':offset,'bytes':len(payload),'sha256':hash(payload),'kind':'JUMBF-fragment','instance':instance,'sequence':sequence,'boxBytes':boxLength})
                elif 0xe0<=marker<=0xef:
                    row['otherApps'].append({'marker':marker,'offset':offset,'bytes':len(payload),'sha256':hash(payload),'prefixHex':payload[:16].hex()})
                if kind:
                    number=sum(x['kind']==kind for x in row['metadata']);file=row['name']+'-'+kind+'-'+str(number)+'.bin'
                    (root/'payloads'/file).write_bytes(raw)
                    row['metadata'].append({'kind':kind,'file':'payloads/'+file,'bytes':len(raw),'sha256':hash(raw),'segmentOffset':offset,'segmentPayloadBytes':len(payload),'segmentPayloadSha256':hash(payload)})
            for guid,item in extensions.items():
                parts=sorted(item['parts']); assembled=bytearray(); at=0
                for partOffset,part in parts:
                    if partOffset!=at:raise ValueError('Extended XMP gap or overlap')
                    assembled.extend(part);at+=len(part)
                raw=bytes(assembled)
                if len(raw)!=item['length'] or hashlib.md5(raw).hexdigest().upper()!=guid:raise ValueError('Extended XMP length/digest mismatch')
                if not any(guid.encode('ascii') in (root/x['file']).read_bytes() for x in row['metadata'] if x['kind']=='xmp'):raise ValueError('Extended XMP lacks matching primary packet')
                number=sum(x['kind']=='xmp' for x in row['metadata']);file=row['name']+'-xmp-'+str(number)+'.bin'
                (root/'payloads'/file).write_bytes(raw)
                row['metadata'].append({'kind':'xmp','role':'extended','guid':guid,'file':'payloads/'+file,'bytes':len(raw),'sha256':hash(raw),'fragments':len(parts),'guidMD5Verified':True})
            for (instance,boxType),item in jumbf.items():
                if sorted(item['parts'])!=list(range(1,len(item['parts'])+1)):raise ValueError('JUMBF sequence gap')
                raw=b''.join(item['parts'][k] for k in sorted(item['parts']))
                if len(item['header'])+len(raw)!=item['length']:raise ValueError('JUMBF reassembly length')
                number=sum(x['kind']=='jumb' for x in row['metadata']);file=row['name']+'-jumb-'+str(number)+'.bin'
                (root/'payloads'/file).write_bytes(raw)
                row['metadata'].append({'kind':'jumb','file':'payloads/'+file,'bytes':len(raw),'sha256':hash(raw),'instance':instance,'fullBoxBytes':item['length'],'fullBoxSha256':hash(item['header']+raw),'fragments':len(item['parts'])})
            manifest['rows'].append(row)
(root/'phone-metadata-sources.json').write_text(json.dumps(manifest,indent=2)+'\n')
for r in manifest['rows']:
    print(json.dumps({'name':r['name'],'device':r.get('device'),'fields':[(x['kind'],x['bytes']) for x in r['metadata']],'extendedFragments':len(r['extendedXmpFragments']),'otherApps':[(x.get('kind',hex(x['marker'])),x['bytes']) for x in r['otherApps']]}))
