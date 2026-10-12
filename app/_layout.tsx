import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { MarkersProvider } from '../contexts/MarkersContext';

export default function RootLayout() {
  return (
    <MarkersProvider>
      <StatusBar style="dark" />
      <Stack>
        <Stack.Screen name="index" options={{ title: 'Карта' }} />
        <Stack.Screen name="marker/[id]" options={{ title: 'Детали метки' }} />
      </Stack>
    </MarkersProvider>
  );
}
