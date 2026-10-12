import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect, useRouter, type ErrorBoundaryProps } from 'expo-router';
import { ActivityIndicator, Button, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDatabase } from '../contexts/DatabaseContext';
import { DatabaseStatus } from '../components/DatabaseStatus';

const INITIAL_REGION = {
  latitude: 56.8389,
  longitude: 60.6057,
  latitudeDelta: 0.06,
  longitudeDelta: 0.06,
};

// Expo Router перехватывает ошибки рендера экрана, но не нативные сбои карты.
export function ErrorBoundary({ retry }: ErrorBoundaryProps) {
  return (
    <SafeAreaView style={styles.errorScreen}>
      <Text>Не удалось отобразить карту. Попробуйте открыть её ещё раз.</Text>
      <Button title="Повторить" onPress={() => void retry()} />
    </SafeAreaView>
  );
}

export default function MapScreen() {
  const { markers, addMarker, refresh, isLoading, error } = useDatabase();
  const adding = useRef(false);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [isReady, setIsReady] = useState(false);
  const [isTakingLong, setIsTakingLong] = useState(false);
  const [mapKey, setMapKey] = useState(0);

  useFocusEffect(useCallback(() => {
    void refresh().catch(() => undefined);
  }, [refresh]));

  useEffect(() => {
    if (isReady) return;

    const timer = setTimeout(() => setIsTakingLong(true), 15000);
    return () => clearTimeout(timer);
  }, [isReady, mapKey]);

  function retryMap() {
    setIsReady(false);
    setIsTakingLong(false);
    setMapKey((current) => current + 1);
  }

  return (
    <View style={styles.container}>
      <MapView
        key={mapKey}
        style={StyleSheet.absoluteFill}
        initialRegion={INITIAL_REGION}
        loadingEnabled
        onMapReady={() => {
          setIsReady(true);
          setIsTakingLong(false);
        }}
        onLongPress={({ nativeEvent }) => {
          if (isLoading || error || adding.current) return;
          const { latitude, longitude } = nativeEvent.coordinate;
          adding.current = true;
          void addMarker(latitude, longitude)
            .catch(() => undefined)
            .finally(() => { adding.current = false; });
        }}
      >
        {markers.map((marker) => (
          <Marker
            key={marker.id}
            coordinate={{ latitude: marker.latitude, longitude: marker.longitude }}
            title={`Метка №${marker.id}`}
            onPress={() => router.push({
              pathname: '/marker/[id]',
              params: { id: String(marker.id) },
            })}
          />
        ))}
      </MapView>

      <View pointerEvents="none" style={[styles.hint, { bottom: insets.bottom + 12 }]}>
        <Text>Удерживайте карту, чтобы добавить метку. Нажмите на метку, чтобы открыть её.</Text>
        <Text>Маркеров: {markers.length}</Text>
      </View>

      {!isReady && (
        <View style={styles.loading}>
          <View style={styles.card}>
            {isTakingLong ? (
              <>
                <Text>Карта пока не готова. Проверьте подключение к интернету и попробуйте ещё раз.</Text>
                <Button title="Повторить" onPress={retryMap} />
              </>
            ) : (
              <>
                <ActivityIndicator size="large" />
                <Text>Загрузка карты…</Text>
              </>
            )}
          </View>
        </View>
      )}
      <View style={styles.databaseStatus}><DatabaseStatus /></View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  databaseStatus: { position: 'absolute', top: 0, left: 0, right: 0 },
  hint: {
    position: 'absolute', left: 16, right: 16,
    padding: 12, gap: 4, borderRadius: 8, backgroundColor: '#ffffffee',
  },
  loading: { ...StyleSheet.absoluteFill, justifyContent: 'center', padding: 24 },
  card: { padding: 20, gap: 16, borderRadius: 8, backgroundColor: '#ffffff', alignItems: 'center' },
  errorScreen: { flex: 1, justifyContent: 'center', padding: 24, gap: 16 },
});
