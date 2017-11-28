import React, { Component } from 'react';
import { View, Image, Alert, TouchableHighlight, StyleSheet} from 'react-native';
import { connect } from 'react-redux';
import { Container, Title, Text,  Button, Content, Header, Form, Item, Input, Label, Picker} from 'native-base';
import ImagePicker from 'react-native-image-picker';
import { HeaderApp, FooterMenu, PickerElement } from './common';
import realm from '../Models';
import PubSub from 'pubsub-js';
import { Actions } from 'react-native-router-flux';
import PolylineCreator from './common/PolylineCreator';


class CropAdd extends Component {

  constructor(props) {
    super(props);
    this.state = {
      dimension: 0,
      name:'',
      cropType:'',
      variety:'',
    }
  }
  componentWillMount() {
    PubSub.subscribe('card', this.subscriber.bind(this));

  }
  subscriber(msg, data){
    this.setState({card:data.toUpperCase()});
  }
  onValueChange (value: string) {
      this.setState({
          documentType : value
      });
  }
  createCrop(data) {
    let nextID = 1;
    let crops = realm.objects('Crop').sorted('creationDate', true);
    if(crops.length  > 0) {
      nextID =crops[0].id+1;
    }

    realm.write(() => {
      realm.create('Crop', {
        id: nextID,
        name: this.state.name,
        type: this.state.cropType,
        variety: this.state.variety,

        dimension: parseFloat(this.state.dimension),
        creationDate: new Date()});
    });

    Actions.crops();
  }
  changeAvatar() {
    var options = {
      title: 'Select Avatar',
      storageOptions: {
        skipBackup: true,
        path: 'bascula'
      }
    };
  ImagePicker.showImagePicker(options, (response) => {
    console.log('Response = ', response);

    if (response.didCancel) {
      console.log('User cancelled image picker');
    }
    else if (response.error) {
      console.log('ImagePicker Error: ', response.error);
    }
    else if (response.customButton) {
      console.log('User tapped custom button: ', response.customButton);
    }
    else {


      // You can also display the image using data:
      let source = { uri: 'data:image/jpeg;base64,' + response.data, isStatic: true };
      this.setState({
        avatarSource: source,
      });
      this.setState({
        avatarUri:response.uri,
      });
    }
  });
}

  render() {
    const { ContainerStyle, HeaderStyle, LabelStyle, PickerStyle, PickerItemStyle, ButtonStyle, ImageStyle, AvatarContainerStyle} = styles;

    return (
      <Container>
      <HeaderApp >
          Agregar Lote
      </HeaderApp>

      <Form>
        <View style={styles.container}>
          <PolylineCreator/>
        </View>
        <Item floatingLabel>
          <Label>Nombre</Label>
          <Input onChangeText={name => this.setState({ name })} />
        </Item>
        <Item floatingLabel>
          <Label>Hectáreas</Label>
          <Input onChangeText={dimension => this.setState({ dimension })}/>
        </Item>

        <Item floatingLabel>
          <Label>Tipo de Cultivo</Label>
          <Input onChangeText={cropType => this.setState({ cropType })}/>
        </Item>

        <Item floatingLabel>
          <Label>Variedad</Label>
          <Input onChangeText={variety => this.setState({ variety })}/>
        </Item>

       <View style={ButtonStyle}>
          <Button style={ButtonStyle} onPress={this.createCrop.bind(this)} rounded success>
            <Text>Agregar Lote</Text>
          </Button>
        </View>


      </Form>
      </Container>
    );
  }
}

const styles = {
  HeaderStyle: {
    paddingTop:0,
    marginTop:0,
  },

  container: {
    width:'auto',
    height:200,
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  LabelStyle: {
    width:'40%',
  },
  PickerStyle: {
    width:'auto',
  },
  PickerItemStyle: {
    textAlign:'left',
    marginLeft:0,
  },
  ButtonStyle: {
    marginTop:10,
    marginBottom:10,
    marginLeft:'5%',
    justifyContent: 'center',
    alignItems: 'center',
    width: '90%',
  },
  ImageStyle:{
    width: 140,
    height: 140,
    marginTop:70,
  },
  AvatarContainerStyle:{
    justifyContent: 'center',
    marginBottom:30,
    alignItems: 'center', 
  }
};
export default CropAdd
