import { Link, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function MarkerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  return (
    <SafeAreaView style={styles.container} edges={['bottom', 'left', 'right']}>
      <Text style={styles.title}>Метка №{id}</Text>
      <Text style={styles.description}>
        Здесь появятся координаты и изображения метки. Пока это экран-заглушка.
      </Text>
      <Link href="/" dismissTo style={styles.link}>
        Вернуться к карте
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
