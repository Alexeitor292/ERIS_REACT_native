import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Alert } from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { apiFetch } from "../../src/api/client";
import { consumeSessionExpiredNotice, setToken } from "../../src/auth/tokenStore";

type LoginResponse = { access_token: string; token_type: string };

export default function Login() {
  const [email, setEmail] = useState("admin@local");
  const [password, setPassword] = useState("password");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    consumeSessionExpiredNotice()
      .then((message) => {
        if (message) {
          Alert.alert("Session expired", message);
        }
      })
      .catch(() => {});
  }, []);

  async function onLogin() {
    try {
      setLoading(true);
      const res = await apiFetch<LoginResponse>("/auth/login", {
        method: "POST",
        body: { email: email.trim().toLowerCase(), password: password.trim() },
      });
      await setToken(res.access_token);
      router.replace("/(tabs)/incidents/track");
    } catch (e: any) {
      Alert.alert("Login failed", String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>ERIS</Text>

        <Text style={styles.label}>Email</Text>
        <TextInput
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          placeholder="admin@local"
          placeholderTextColor="#6b7280"
          style={styles.input}
        />

        <Text style={styles.label}>Password</Text>
        <TextInput
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          placeholder="password"
          placeholderTextColor="#6b7280"
          style={styles.input}
        />

        <Pressable style={styles.button} onPress={onLogin} disabled={loading}>
          <Text style={styles.buttonText}>{loading ? "Signing in..." : "Sign in"}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f8fafc" },
  content: { flex: 1, padding: 20, justifyContent: "center", gap: 10 },
  title: { fontSize: 32, fontWeight: "700", marginBottom: 10, color: "#0f172a" },
  label: { fontSize: 14, opacity: 0.8, color: "#334155" },
  input: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 10,
    padding: 12,
    backgroundColor: "#ffffff",
    color: "#0f172a",
  },
  button: { backgroundColor: "black", padding: 14, borderRadius: 12, marginTop: 10 },
  buttonText: { color: "white", fontWeight: "600", textAlign: "center" },
});
