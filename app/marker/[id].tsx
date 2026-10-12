import { Link, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMarkers } from '../../contexts/MarkersContext';
import type { MarkerRouteParams } from '../../types';
import { parseMarkerId } from '../../utils/parseMarkerId';

export default function MarkerScreen() {
  const { id } = useLocalSearchParams<MarkerRouteParams>();
  const { markers } = useMarkers();
  const markerId = parseMarkerId(id);
  const marker = markers.find((item) => item.id === markerId);

  return (
    <SafeAreaView style={styles.container} edges={['bottom', 'left', 'right']}>
      {markerId === null ? (
        <>
          <Text style={styles.title}>Некорректный ID метки</Text>
          <Text style={styles.description}>ID должен быть положительным целым числом.</Text>
        </>
      ) : !marker ? (
        <>
          <Text style={styles.title}>Метка не найдена</Text>
          <Text style={styles.description}>
            Метки №{markerId} нет в памяти. После перезапуска приложения метки сбрасываются.
          </Text>
        </>
      ) : (
        <>
          <Text style={styles.title}>Метка №{marker.id}</Text>
          <Text style={styles.description}>ID: {marker.id}</Text>
          <Text style={styles.description}>Широта: {marker.latitude.toFixed(6)}</Text>
          <Text style={styles.description}>Долгота: {marker.longitude.toFixed(6)}</Text>
        </>
      )}
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
