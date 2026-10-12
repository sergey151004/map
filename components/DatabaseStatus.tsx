import { ActivityIndicator, Button, StyleSheet, Text, View } from 'react-native';
import { useDatabase } from '../contexts/DatabaseContext';

export function DatabaseStatus() {
  const { isLoading, error, retry, dismissError } = useDatabase();
  if (!isLoading && !error) return null;
  return (
    <View style={styles.container}>
      {isLoading && <ActivityIndicator accessibilityLabel="Обновление данных" />}
      {error && <>
        <Text accessibilityRole="alert" style={styles.error}>{error.message}</Text>
        <Button title="Повторить операцию" disabled={isLoading} onPress={() => void retry().catch(() => undefined)} />
        <Button title="Закрыть ошибку" disabled={isLoading} onPress={dismissError} />
      </>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 12, gap: 8, backgroundColor: '#ffffff' },
  error: { color: '#b91c1c' },
});
