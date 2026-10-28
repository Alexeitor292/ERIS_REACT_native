import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Alert, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { apiFetch } from "../../src/api/client";
import { consumeSessionExpiredNotice, setToken } from "../../src/auth/tokenStore";
import { EntraSignInError, type EntraMobileConfig } from "../../src/auth/entraPkce";
import { signInWithEntra } from "../../src/auth/entraSignIn";

type LoginResponse = { access_token: string; token_type: string };
type SignInMethods = { local_login_enabled: boolean; entra_mobile: EntraMobileConfig | null };

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  // The API decides which sign-in methods exist. Until it answers, nothing is
  // offered; if it cannot be reached, the password form is the fallback that
  // the API will refuse anyway when it is switched off.
  const [methods, setMethods] = useState<SignInMethods | null>(null);
  const [methodsError, setMethodsError] = useState(false);

  useEffect(() => {
    consumeSessionExpiredNotice()
      .then((message) => {
        if (message) {
          Alert.alert("Session expired", message);
        }
      })
      .catch(() => {});
    apiFetch<SignInMethods>("/auth/config")
      .then((live) => setMethods({ local_login_enabled: !!live.local_login_enabled, entra_mobile: live.entra_mobile ?? null }))
      .catch(() => setMethodsError(true));
  }, []);

  async function finish(token: string) {
    await setToken(token);
    router.replace("/(tabs)/incidents/track");
  }

  async function onLogin() {
    try {
      setLoading(true);
      const res = await apiFetch<LoginResponse>("/auth/login", {
        method: "POST",
        body: { email: email.trim().toLowerCase(), password: password.trim() },
      });
      await finish(res.access_token);
    } catch (e: any) {
      Alert.alert("Login failed", String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  async function onEntra() {
    if (!methods?.entra_mobile) return;
    try {
      setLoading(true);
      await finish(await signInWithEntra(methods.entra_mobile));
    } catch (e: any) {
      if (e instanceof EntraSignInError && e.reason === "cancelled") return;
      Alert.alert("Caltrans sign-in failed", e instanceof EntraSignInError ? e.message : "Try again.");
    } finally {
      setLoading(false);
    }
  }

  const showPassword = methodsError || !!methods?.local_login_enabled;

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>ERIS</Text>

        {!methods && !methodsError ? <ActivityIndicator /> : null}

        {methods?.entra_mobile ? (
          <Pressable style={styles.button} onPress={onEntra} disabled={loading}>
            <Text style={styles.buttonText}>{loading ? "Signing in..." : "Sign in with Caltrans Microsoft Entra"}</Text>
          </Pressable>
        ) : null}

        {methods && !methods.entra_mobile && !methods.local_login_enabled ? (
          <Text style={styles.label}>
            This ERIS server signs in through Caltrans Entra, which is not yet enabled for the mobile app. Contact the ERIS administrator.
          </Text>
        ) : null}

        {showPassword ? (
          <>
            <Text style={styles.label}>Email</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              placeholder="name@dot.ca.gov"
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
          </>
        ) : null}
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
