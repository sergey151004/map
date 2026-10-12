import { useState } from 'react';
import { Button, Image, StyleSheet, Text, View } from 'react-native';
import type { MarkerImage } from '../types';

interface ImageListProps {
  images: MarkerImage[];
  onDelete: (imageId: number) => void;
}

function ImageItem({ image, onDelete }: { image: MarkerImage; onDelete: () => void }) {
  const [hasError, setHasError] = useState(false);

  return (
    <View style={styles.item}>
      {hasError ? (
        <View style={styles.preview}>
          <Text>Не удалось загрузить фото. Удалите его и выберите заново.</Text>
        </View>
      ) : (
        <Image
          source={{ uri: image.uri }}
          style={styles.preview}
          resizeMode="cover"
          accessibilityLabel={`Фото №${image.id}`}
          onError={() => setHasError(true)}
        />
      )}
      <View style={styles.actions}>
        <Text>Фото №{image.id}</Text>
        <Button title="Удалить фото" onPress={onDelete} />
      </View>
    </View>
  );
}

export function ImageList({ images, onDelete }: ImageListProps) {
  if (images.length === 0) {
    return <Text>Фотографий пока нет. Нажмите «Добавить изображение», чтобы выбрать фото из галереи.</Text>;
  }

  return (
    <View style={styles.list}>
      {images.map((image) => (
        <ImageItem key={image.id} image={image} onDelete={() => onDelete(image.id)} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 16 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  preview: { width: 120, height: 120, borderRadius: 8, backgroundColor: '#eeeeee', padding: 8, justifyContent: 'center' },
  actions: { flex: 1, gap: 8 },
});
