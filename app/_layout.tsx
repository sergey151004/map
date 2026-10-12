import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { DatabaseProvider } from '../contexts/DatabaseContext';
import { LocationProvider } from '../contexts/LocationContext';
import '../services/notifications';
import { ProximityProvider } from '../contexts/ProximityContext';

export default function RootLayout() {
  return (
    <DatabaseProvider>
      <LocationProvider>
        <ProximityProvider>
          <StatusBar style="dark" />
          <Stack>
            <Stack.Screen name="index" options={{ title: 'Карта' }} />
            <Stack.Screen name="marker/[id]" options={{ title: 'Детали метки' }} />
          </Stack>
        </ProximityProvider>
      </LocationProvider>
    </DatabaseProvider>
  );
}
