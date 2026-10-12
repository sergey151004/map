import { Link } from 'expo-router';
import { StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function MapScreen() {
  return (
    <SafeAreaView style={styles.container} edges={['bottom', 'left', 'right']}>
      <Text style={styles.title}>Карта и метки</Text>
      <Text style={styles.description}>
        Здесь появится карта. Сейчас можно проверить переход на экран метки.
      </Text>
      <Link href={{ pathname: '/marker/[id]', params: { id: '1' } }} style={styles.link}>
        Открыть тестовую метку
      </Link>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, gap: 16, backgroundColor: '#ffffff' },
  title: { fontSize: 24, fontWeight: '600' },
  description: { fontSize: 16, lineHeight: 24 },
  link: { fontSize: 18, color: '#1d4ed8', paddingVertical: 12 },
});
