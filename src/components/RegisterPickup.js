import React, { Component } from 'react';
import { View, Image, Alert} from 'react-native';
import { connect } from 'react-redux';
import { Container, Title, Text,  Button, Content, Header, Form, Item, Input, Label, Picker} from 'native-base';
import ImagePicker from 'react-native-image-picker';
import { HeaderApp, FooterMenu, PickerElement } from './common';
import DatePicker from 'react-native-datepicker'

import realm from '../Models';
import PubSub from 'pubsub-js';
import { Actions } from 'react-native-router-flux';


class RegisterPickup extends Component {

  constructor(props) {
    super(props);
    let fDate = new Date();

    this.state = {
      crops: {},
      crop: 1,
      card: '',
      weight:'',
      person: {
        name:'',
        avatar:'',
      },
      date: fDate.getUTCFullYear()+"-"+(fDate.getMonth()+1)+"-"+fDate.getUTCDate(),
      avatarSource: require('./worker.png'),

    }
  }
  componentWillMount() {
    let crops = realm.objects('Crop').sorted('name',true);
    this.setState({ crops:crops })

    if(this.props.card) {
      this.setState({card: this.props.card.toUpperCase()})
      let person = realm.objects('Person').filtered(`tag = "${this.props.card.toUpperCase()}"`);
      if (person.length > 0) {
        this.setState({person:{
          name: person[0].name,
          avatar: person[0].image,
        }})

    }      
    }


    PubSub.subscribe('weight', this.subscriber.bind(this));

  }
  componentWillReceiveProps(nextProps){
    console.log(nextProps);
  }

  subscriber(msg, data){
    this.setState({weight:data.toUpperCase()});
  }

  onValueChange (value: string) {
      this.setState({
          crop : value
      });
  }
  createPickup(data) {

    let nextID = 1;
    let pickups = realm.objects('Pickup').sorted('creationDate', true);
    if(pickups.length  > 0) {
      nextID =pickups[0].id+1;
    }

    realm.write(() => {
      realm.create('Pickup', {
        id: nextID,
        card: this.state.card,
        crop: this.state.crop,
        weight: parseFloat(this.state.weight),
        date: new Date(this.state.date),
        creationDate: new Date(),
      });
    });
    Actions.harvest();

  }

  render() {
    const { Name, WeightLabelNumber, WeightLabel, ContainerStyle, HeaderStyle, LabelStyle, PickerStyle, PickerItemStyle, ButtonStyle, ImageStyle, AvatarContainerStyle} = styles;


    return (
      <Container>
      <HeaderApp >
          Registrar Recolección
      </HeaderApp>
          <Text style={Name}>{this.state.person.name} </Text>

      <Form>
        <Container style={AvatarContainerStyle}>
            <Image borderRadius={70} style={ImageStyle} source={{ uri: this.state.person.avatar }} />
        </Container>

        <Item >
          <Label>Tarjeta</Label>
          <Input style={{ textAlign: 'right',marginRight:30 }} onChangeText={card => this.setState({ card })}  value={this.state.card} />
        </Item>  
        <Item style={{ marginTop: 20}} inlineLabel>
          <Label style={LabelStyle} >Lote: </Label>
          <Picker
              style={PickerStyle}
              mode='dropdown'
              selectedValue={this.state.crop}
              onValueChange={this.onValueChange.bind(this)}>
              {Object.keys(this.state.crops).map((key) => {
                return (<Picker.Item style={PickerItemStyle} label={this.state.crops[key].name} value={this.state.crops[key].id} key={this.state.crops[key].id}/>) 
              })}
          </Picker>
          </Item>
        
       <Item>
          <Label>Peso ( KGS )</Label>
          <Input style={ WeightLabel } value={this.state.weight} onChangeText={weight => this.setState({ weight })} />
          


        </Item>


       <Item >
          <Label>Fecha</Label>
          <DatePicker
            style={{width: 310, borderWidth:0,}}
            date={this.state.date}
            mode="date"
            placeholder="Seleccione una fecha"
            format="YYYY-MM-DD"
            confirmBtnText="Confirmar"
            cancelBtnText="Cancelar"
            customStyles={{
              dateIcon: {
                position: 'absolute',
                right: 25,
                top: 4,
                marginLeft: 0
              },
              dateInput: {
                borderWidth:0,
                marginLeft: 36
              }
            }}
            onDateChange={(date) => {this.setState({date: date})}}
          />
          </Item>

       <View style={ButtonStyle}>
          <Button style={ButtonStyle} onPress={this.createPickup.bind(this)} rounded success>
            <Text>Registrar Recolección</Text>
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
    marginLeft:23,
    alignSelf:'flex-end',

    borderColor:'#000'
  },
  PickerItemStyle: {
    position:'absolute',
    textAlign:'right',
    right:10,
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
    width: 150,
    height: 150,
    marginTop:-140,
  },
  AvatarContainerStyle:{
    justifyContent: 'center',
    marginBottom:30,
    marginTop:10,
    alignItems: 'center', 
  },
  WeightLabel:{
    fontSize:30,
    fontWeight:'bold',
    alignItems: 'center',
    textAlign:'right',
    marginRight:35,
    flex:1,
    marginTop:5,
    marginBottom:5,
    paddingBottom:0
  },
  Name: {
    flex:1,
    marginTop:-90,
    fontSize:30,
    fontWeight:'bold',
    textAlign:'center',
  },
  WeightLabelNumber:{
    fontSize:30,
    textAlign:'right',
    flex:1,
    marginTop:5,
    marginBottom:5,
    paddingBottom:0

  }

};
export default RegisterPickup
