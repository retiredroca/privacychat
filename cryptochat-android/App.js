/**
 * CryptoChat Android — App.js
 * Root component. Starts the JS↔Native overlay bridge and renders HomeScreen.
 */

import React, { useEffect } from 'react';
import { StatusBar } from 'react-native';
import HomeScreen from './src/screens/HomeScreen';
import { startBridge, stopBridge } from './src/services/OverlayBridge';

export default function App() {
  useEffect(() => {
    startBridge();
    return () => stopBridge();
  }, []);

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />
      <HomeScreen />
    </>
  );
}
