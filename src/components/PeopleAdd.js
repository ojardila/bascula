import React, { Component } from 'react';
import { View, Image, Alert, TouchableHighlight} from 'react-native';
import { connect } from 'react-redux';
import { Container, Title, Text,  Button, Content, Header, Form, Item, Input, Label, Picker} from 'native-base';
import ImagePicker from 'react-native-image-picker';
import { HeaderApp, FooterMenu, PickerElement } from './common';
import realm from '../Models';
import PubSub from 'pubsub-js';
import { Actions } from 'react-native-router-flux';


class PeopleAdd extends Component {

  constructor(props) {
    super(props);
    this.state = {
      selectedItem: undefined,
      documentType: 'cc',
      name:'',
      lastName:'',
      id:'',
      tag:'',
      card:'',
      results: {
          items: []
      },
      avatarSource: require('./worker.png'),
      avatarUri:'',

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
  createPerson(data) {
    let people = realm.objects('Person');
    let properties = this.state;
    realm.write(() => {
      realm.create('Person', {
        name: this.state.name,
        lastName: this.state.lastName,
        image: this.state.avatarUri,
        id: this.state.id,
        tag: this.state.card,
        documentType: this.state.documentType,
        creationDate: new Date()});
    });

    Actions.people();
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
          Agregar Persona
      </HeaderApp>

      <Form>
        <Container style={AvatarContainerStyle}>
          <TouchableHighlight style={AvatarContainerStyle} onPress={this.changeAvatar.bind(this)}>
            <Image borderRadius={70} style={ImageStyle} source={this.state.avatarSource} />
          </TouchableHighlight>
        </Container>
        <Item floatingLabel>
          <Label>Nombres</Label>
          <Input onChangeText={name => this.setState({ name })} />
        </Item>
        <Item floatingLabel>
          <Label>Apellidos</Label>
          <Input onChangeText={lastName => this.setState({ lastName })}/>
        </Item>
        <Item style={{ marginTop: 20}} inlineLabel>
          <Label style={LabelStyle} >Tipo de Identificación: </Label>
          <Picker
              style={PickerStyle}
              mode='dropdown'
              selectedValue={this.state.documentType}
              onValueChange={this.onValueChange.bind(this)}>
              <Picker.Item style={PickerItemStyle} label='Cédula de Ciudadanía' value='cc' />
              <Picker.Item style={PickerItemStyle} label='Cédula de Extranjería' value='ce' />
              <Picker.Item style={PickerItemStyle} label='Pasaporte' value='pa' />
              <Picker.Item style={PickerItemStyle} label='Tarjeta de identidad' value='ti' />
          </Picker>
          </Item>
       <Item floatingLabel>
          <Label>Identificación</Label>

          <Input onChangeText={id => this.setState({ id })} />
        </Item>
       <Item floatingLabel>
          <Label>Tarjeta</Label>

          <Input onChangeText={card => this.setState({ card })} value={this.state.card} />
        </Item>
       <View style={ButtonStyle}>
          <Button style={ButtonStyle} onPress={this.createPerson.bind(this)} rounded success>
            <Text>Agregar Persona</Text>
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
export default PeopleAdd
