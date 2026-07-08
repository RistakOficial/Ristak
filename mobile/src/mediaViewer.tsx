// In-app content viewers — keep media/links inside our own app ("focus modal")
// instead of Linking.openURL, which launches the external Safari app.
//   - Images  -> full-screen zoomable lightbox (GlobalImageViewer, openImageViewer)
//   - Links/docs -> in-app browser overlay (openInAppBrowser => SFSafariViewController)
import React, { useEffect, useState } from 'react';
import { Image, Linking, Modal, Pressable, ScrollView, StatusBar, StyleSheet, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { X } from 'lucide-react-native';

// --- In-app browser (links, documents, payment links) -----------------------
export async function openInAppBrowser(url: string | null | undefined): Promise<void> {
  const target = String(url || '').trim();
  if (!target) return;
  try {
    await WebBrowser.openBrowserAsync(target, {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      dismissButtonStyle: 'close',
      // Tinted controls that read on either theme.
      controlsColor: '#18b66f',
    });
  } catch {
    // Only fall back to the OS browser if the in-app one genuinely fails.
    try {
      await Linking.openURL(target);
    } catch {
      // ignore
    }
  }
}

// --- Full-screen image lightbox --------------------------------------------
// Single module-level subscriber: a <GlobalImageViewer/> mounted once at the app
// root listens, so any message/media tile can open it without threading context.
type Listener = (uri: string | null) => void;
let listener: Listener | null = null;

export function openImageViewer(uri: string | null | undefined): void {
  const target = String(uri || '').trim();
  if (target) listener?.(target);
}

export function GlobalImageViewer(): React.ReactElement {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    listener = setUri;
    return () => {
      if (listener === setUri) listener = null;
    };
  }, []);
  const close = () => setUri(null);
  return (
    <Modal visible={!!uri} transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
      <View style={styles.root}>
        <StatusBar barStyle="light-content" />
        {/* Pinch-to-zoom via native ScrollView zoom; single tap dismisses. */}
        <ScrollView
          style={styles.zoom}
          contentContainerStyle={styles.zoomContent}
          maximumZoomScale={4}
          minimumZoomScale={1}
          centerContent
          bouncesZoom
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        >
          <Pressable style={styles.imageTap} onPress={close}>
            {uri ? <Image source={{ uri }} resizeMode="contain" style={styles.image} /> : null}
          </Pressable>
        </ScrollView>
        <Pressable accessibilityRole="button" accessibilityLabel="Cerrar" onPress={close} hitSlop={12} style={styles.closeButton}>
          <X size={22} color="#ffffff" strokeWidth={2.7} />
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'rgba(0,0,0,0.97)' },
  zoom: { flex: 1 },
  zoomContent: { flexGrow: 1 },
  imageTap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  image: { width: '100%', height: '100%' },
  closeButton: {
    position: 'absolute',
    top: 58,
    right: 20,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
