import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { DatabaseProvider } from '../contexts/DatabaseContext';

export default function RootLayout() {
  return (
    <DatabaseProvider>
      <StatusBar style="dark" />
      <Stack>
        <Stack.Screen name="index" options={{ title: 'Карта' }} />
        <Stack.Screen name="marker/[id]" options={{ title: 'Детали метки' }} />
      </Stack>
    </DatabaseProvider>
  );
}
