import { Alert, Button, Linking, Text, View } from 'react-native';
import { useProximity } from '../contexts/ProximityContext';

export function ProximityStatus() {
  const { error, retry } = useProximity();
  if (!error) return null;
  return (
    <View style={{ padding: 10, gap: 4, backgroundColor: '#ffffffee' }}>
      <Text accessibilityRole="alert">{error}</Text>
      <Button title="Повторить уведомления" onPress={retry} />
      <Button title="Настройки уведомлений" onPress={() => {
        void Linking.openSettings().catch(() => Alert.alert('Откройте настройки вручную', 'Проверьте уведомления Expo Go.'));
      }} />
    </View>
  );
}
