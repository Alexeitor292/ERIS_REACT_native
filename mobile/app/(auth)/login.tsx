import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Alert } from "react-native";
import { router } from "expo-router";
import { apiFetch } from "../../src/api/client";
import { setToken } from "../../src/auth/tokenStore";

type LoginResponse = { access_token: string; token_type: string };

export default function Login() {
  const [email, setEmail] = useState("admin@local");
  const [password, setPassword] = useState("password");
  const [loading, setLoading] = useState(false);

  async function onLogin() {
    try {
      setLoading(true);
      const res = await apiFetch<LoginResponse>("/auth/login", {
        method: "POST",
        body: { email, password },
      });
      await setToken(res.access_token);
      router.replace("/(tabs)/submissions");
    } catch (e: any) {
      Alert.alert("Login failed", String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>ERIS</Text>

      <Text style={styles.label}>Email</Text>
      <TextInput value={email} onChangeText={setEmail} autoCapitalize="none" style={styles.input} />

      <Text style={styles.label}>Password</Text>
      <TextInput value={password} onChangeText={setPassword} secureTextEntry style={styles.input} />

      <Pressable style={styles.button} onPress={onLogin} disabled={loading}>
        <Text style={styles.buttonText}>{loading ? "Signing in..." : "Sign in"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, justifyContent: "center", gap: 10 },
  title: { fontSize: 32, fontWeight: "700", marginBottom: 10 },
  label: { fontSize: 14, opacity: 0.8 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 10, padding: 12 },
  button: { backgroundColor: "black", padding: 14, borderRadius: 12, marginTop: 10 },
  buttonText: { color: "white", fontWeight: "600", textAlign: "center" },
});
