import React from 'react';
import { WebView } from 'react-native-webview';

export default function NoticeScreen() {
  return <WebView source={{ uri: 'https://m.example.com/notice/list.do' }} />;
}
