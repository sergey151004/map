import { ActivityIndicator, Alert, Button, Linking, StyleSheet, Text, View } from 'react-native';
import { useLocation } from '../contexts/LocationContext';

export function LocationStatus({ onCenter, mapReady }: { onCenter: () => void; mapReady: boolean }) {
  const { status, position, message, canAskAgain, retry } = useLocation();
  const waiting = status === 'checking' || status === 'waiting';
  return (
    <View style={styles.container}>
      <View style={styles.row}>
        {waiting && <ActivityIndicator size="small" />}
        <Text style={styles.text}>{message}</Text>
      </View>
      {position && status === 'tracking' && <>
        <Text>{position.coords.latitude.toFixed(6)}, {position.coords.longitude.toFixed(6)}</Text>
        <Button title="Моё местоположение" disabled={!mapReady} onPress={onCenter} />
      </>}
      {(status === 'waiting' || status === 'disabled' || status === 'error' || (status === 'denied' && canAskAgain)) && (
        <Button title="Повторить" onPress={retry} />
      )}
      {status === 'denied' && !canAskAgain && (
        <Button title="Настройки разрешений" onPress={() => {
          void Linking.openSettings().catch(() => Alert.alert('Не удалось открыть настройки', 'Откройте настройки разрешений Expo Go вручную.'));
        }} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 10, gap: 4, backgroundColor: '#ffffffee' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  text: { flex: 1 },
});
