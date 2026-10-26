import { Link, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useDatabase } from '../../contexts/DatabaseContext';
import { DatabaseStatus } from '../../components/DatabaseStatus';
import type { MarkerRouteParams } from '../../types';
import { parseMarkerId } from '../../utils/parseMarkerId';
import { ImageList } from '../../components/ImageList';
import { ProximityStatus } from '../../components/ProximityStatus';

export default function MarkerScreen() {
  const { id } = useLocalSearchParams<MarkerRouteParams>();
  const { markers, images, pickImage: pickMarkerImage, deleteImage, deleteMarker, refresh, isLoading, error } = useDatabase();
  const router = useRouter();
  const deleting = useRef(false);
  const [isAdding, setIsAdding] = useState(false);
  // Ref блокирует повторное нажатие сразу, до следующего рендера кнопки.
  const picking = useRef(false);
  const markerId = parseMarkerId(id);
  const marker = markers.find((item) => item.id === markerId);
  const markerImages = images.filter((image) => image.markerId === markerId);

  useFocusEffect(useCallback(() => {
    void refresh().catch(() => undefined);
  }, [refresh]));

  // Срабатывает и после успешного повтора удаления/очистки файлов.
  useEffect(() => {
    if (deleting.current && !isLoading && !error) {
      deleting.current = false;
      if (!marker) router.dismissTo('/');
    }
  }, [marker, isLoading, error, router]);

  function confirmDeleteMarker() {
    if (!marker || isLoading || error || isAdding) return;
    Alert.alert('Удалить маркер?', 'Маркер и его фотографии будут удалены из приложения.', [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Удалить', style: 'destructive', onPress: () => {
        if (deleting.current) return;
        deleting.current = true;
        void deleteMarker(marker.id).catch(() => undefined);
      } },
    ]);
  }

  async function pickImage() {
    if (!marker || picking.current || isLoading || error) return;
    picking.current = true;
    setIsAdding(true);
    try {
      await pickMarkerImage(marker.id).catch(() => undefined);
    } finally {
      picking.current = false;
      setIsAdding(false);
    }
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.content}>
        <DatabaseStatus />
        {markerId === null ? (
          <>
            <Text style={styles.title}>Некорректный ID метки</Text>
            <Text style={styles.description}>ID должен быть положительным целым числом.</Text>
          </>
        ) : !marker ? (
          <>
            <Text style={styles.title}>Метка не найдена</Text>
            <Text style={styles.description}>
              Метки №{markerId} нет в базе данных.
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.title}>Метка №{marker.id}</Text>
            <Text style={styles.description}>ID: {marker.id}</Text>
            <Text style={styles.description}>Широта: {marker.latitude.toFixed(6)}</Text>
            <Text style={styles.description}>Долгота: {marker.longitude.toFixed(6)}</Text>
            <ProximityStatus />
            <Button
              title={isAdding ? 'Выбор фотографии…' : 'Добавить изображение'}
              onPress={pickImage}
              disabled={isAdding || isLoading || !!error}
            />
            <Text style={styles.heading}>Фотографии ({markerImages.length})</Text>
            <ImageList
              images={markerImages}
              disabled={isAdding || isLoading || !!error}
              onDelete={(imageId) => void deleteImage(imageId).catch(() => undefined)}
            />
            <Button title="Удалить маркер" color="#b91c1c" disabled={isAdding || isLoading || !!error} onPress={confirmDeleteMarker} />
          </>
        )}
        <Link href="/" dismissTo style={styles.link}>
          Вернуться к карте
        </Link>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  content: { padding: 24, gap: 16 },
  title: { fontSize: 24, fontWeight: '600' },
  heading: { fontSize: 20, fontWeight: '600' },
  description: { fontSize: 16, lineHeight: 24 },
  link: { fontSize: 18, color: '#1d4ed8', paddingVertical: 12 },
});
