import React, {createContext, useContext, useEffect, useState, type ReactNode} from 'react';
import {WebView} from 'react-native-webview';
import {createCodec, type JXLCodec} from './codec.ts';
import {ORIGIN, PAGE, modules} from './generated/page.ts';

const Context = createContext<JXLCodec | null>(null);
type Page = React.ComponentRef<typeof WebView>;

// The codec and the page it talks to. The provider hands it the mounted page from an effect, so rendering never reads
// it; a page the system ended is replaced and handed over again.
function startHost() {
  let page: Page | null = null;
  const host = createCodec(
    message => page?.injectJavaScript(`rapier.receive(${JSON.stringify(message)});true;`),
    async name => {
      const load = modules[name];
      if (!load) throw new Error(`There is no ${name} module.`);
      return load();
    });
  return {...host, attach: (next: Page | null) => { page = next; }};
}

/** Mounts the hidden page that runs the encoder. Put it once, high in the tree; calls made before the page is ready wait for it. */
export function JXLProvider({children}: {children?: ReactNode}) {
  const [host] = useState(startHost);
  const [page, setPage] = useState(0);
  const [view, setView] = useState<Page | null>(null);
  useEffect(() => host.attach(view), [host, view]);
  const lost = (message: string) => { host.reset('JXL_WEBVIEW_STOPPED', message); setPage(n => n + 1); };
  return (
    <Context.Provider value={host.codec}>
      {children}
      <WebView
        key={page}
        ref={setView}
        source={{html: PAGE, baseUrl: ORIGIN}}
        style={{position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none'}}
        javaScriptEnabled
        domStorageEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        incognito
        cacheEnabled={false}
        setSupportMultipleWindows={false}
        mixedContentMode="never"
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        onShouldStartLoadWithRequest={request => request.url === 'about:blank' || request.url.startsWith(ORIGIN)}
        onMessage={event => { try { host.receive(JSON.parse(event.nativeEvent.data)); } catch {} }}
        onError={event => lost(event.nativeEvent.description || 'The encoder page did not load.')}
        onContentProcessDidTerminate={() => lost('The system ended the encoder page.')}
        onRenderProcessGone={() => lost('The system ended the encoder page.')}
      />
    </Context.Provider>
  );
}

/** The calls: `encode`, `encodeExact`, `recompress`, `restore` and `animate`. Needs a `JXLProvider` above it. */
export function useJXL(): JXLCodec {
  const codec = useContext(Context);
  if (!codec) throw new Error('useJXL needs a JXLProvider above it.');
  return codec;
}
