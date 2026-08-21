import { useState } from "react";
import { ScrollView, View, StyleSheet } from "react-native";
import { TextInput, Button, HelperText, Avatar, Text } from "react-native-paper";
import * as ImagePicker from "expo-image-picker";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../types";
import { People as PeopleDb } from "../db";
import { useT } from "../i18n";

export default function PeopleAdd({
  navigation,
}: NativeStackScreenProps<RootStackParamList, "PeopleAdd">) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [lastName, setLastName] = useState("");
  const [documentType, setDocumentType] = useState("");
  const [docId, setDocId] = useState("");
  const [tag, setTag] = useState("");
  const [image, setImage] = useState("");

  const valid = name.trim().length > 0;

  async function pickFromGallery() {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.5,
    });
    if (!res.canceled) setImage(res.assets[0].uri);
  }

  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.5,
    });
    if (!res.canceled) setImage(res.assets[0].uri);
  }

  function save() {
    PeopleDb.add({ name: name.trim(), lastName: lastName.trim(), documentType, docId, tag, image });
    navigation.goBack();
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.photo}>
        {image ? (
          <Avatar.Image size={96} source={{ uri: image }} />
        ) : (
          <Avatar.Icon size={96} icon="account" />
        )}
        <View style={styles.photoButtons}>
          <Button icon="image" mode="outlined" compact onPress={pickFromGallery}>
            {t("peopleAdd.gallery")}
          </Button>
          <Button icon="camera" mode="outlined" compact onPress={takePhoto}>
            {t("peopleAdd.camera")}
          </Button>
        </View>
        {!!image && (
          <Text style={styles.removePhoto} onPress={() => setImage("")}>
            {t("peopleAdd.removePhoto")}
          </Text>
        )}
      </View>

      <TextInput label={t("peopleAdd.firstName")} value={name} onChangeText={setName} mode="outlined" />
      <TextInput label={t("peopleAdd.lastName")} value={lastName} onChangeText={setLastName} mode="outlined" />
      <TextInput
        label={t("peopleAdd.docType")}
        value={documentType}
        onChangeText={setDocumentType}
        mode="outlined"
      />
      <TextInput label={t("peopleAdd.docId")} value={docId} onChangeText={setDocId} mode="outlined" />
      <TextInput
        label={t("peopleAdd.rfid")}
        value={tag}
        onChangeText={setTag}
        mode="outlined"
        autoCapitalize="characters"
      />
      <HelperText type="info" visible>
        {t("peopleAdd.rfidHelp")}
      </HelperText>
      <Button mode="contained" icon="content-save" disabled={!valid} onPress={save}>
        {t("peopleAdd.save")}
      </Button>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 12 },
  photo: { alignItems: "center", gap: 10, marginBottom: 4 },
  photoButtons: { flexDirection: "row", gap: 10 },
  removePhoto: { color: "#c0392b", fontSize: 13 },
});
