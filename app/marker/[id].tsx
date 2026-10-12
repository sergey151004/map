import { Link, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Button, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMarkers } from '../../contexts/MarkersContext';
import type { MarkerRouteParams } from '../../types';
import { parseMarkerId } from '../../utils/parseMarkerId';
import { ImageList } from '../../components/ImageList';

export default function MarkerScreen() {
  const { id } = useLocalSearchParams<MarkerRouteParams>();
  const { markers, images, addImage, deleteImage } = useMarkers();
  const [isAdding, setIsAdding] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  // Ref блокирует повторное нажатие сразу, до следующего рендера кнопки.
  const picking = useRef(false);
  const markerId = parseMarkerId(id);
  const marker = markers.find((item) => item.id === markerId);
  const markerImages = images.filter((image) => image.markerId === markerId);

  async function pickImage() {
    if (!marker || picking.current) return;
    picking.current = true;
    setIsAdding(true);
    setPickerError(null);

    try {
      // Системный выбор фото без редактирования не требует полного доступа
      // к медиатеке на поддерживаемых этим Expo SDK версиях Android и iOS.
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        allowsMultipleSelection: false,
        quality: 1,
      });

      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset?.uri) {
        setPickerError('Не удалось получить фотографию. Попробуйте выбрать другую.');
        return;
      }
      addImage(marker.id, asset.uri);
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code) : '';
      setPickerError(code.includes('PERMISSION') || code === 'EACCES'
        ? 'Доступ к фотографии запрещён. Проверьте разрешения приложения в настройках телефона и повторите выбор.'
        : 'Не удалось открыть галерею или прочитать фотографию. Попробуйте ещё раз.');
    } finally {
      picking.current = false;
      setIsAdding(false);
    }
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.content}>
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
            <Button
              title={isAdding ? 'Выбор фотографии…' : 'Добавить изображение'}
              onPress={pickImage}
              disabled={isAdding}
            />
            {pickerError && <Text accessibilityRole="alert" style={styles.error}>{pickerError}</Text>}
            <Text style={styles.heading}>Фотографии ({markerImages.length})</Text>
            <ImageList
              images={markerImages}
              onDelete={(imageId) => deleteImage(marker.id, imageId)}
            />
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
  error: { color: '#b91c1c', fontSize: 16 },
  description: { fontSize: 16, lineHeight: 24 },
  link: { fontSize: 18, color: '#1d4ed8', paddingVertical: 12 },
});
