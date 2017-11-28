import React, { Component } from 'react';
import { View, Text, ListView } from 'react-native';
import { connect } from 'react-redux';
import { Container, Content, Header, Left, Body, Button, List,  Icon, Title, ListItem, Right, Thumbnail, ScrollView} from 'native-base';
import { HeaderApp, FooterMenu } from './common';
import { Actions } from 'react-native-router-flux';
import { SwipeListView } from 'react-native-swipe-list-view';
import PieChartBasic from './PieChart'
import realm from '../Models';
const ds = new ListView.DataSource({rowHasChanged: (r1, r2) => r1 !== r2});

class Home extends Component {

  goToPickupAdd() {
    Actions.register_pickup();
  }

    renderRow(item) {
  const { ListItemPickupStyle, ImagePickupStyle, itemPickupText, separator,label,weightText } = styles;

  let person = realm.objects('Person').filtered(`tag = "${item.card}"`)
  let crop = realm.objects('Crop').filtered(`id = "${item.crop}"`)

  return (
    <View style={separator}>
    <ListItem  avatar style={ListItemPickupStyle} >

      <Body style={itemPickupText}>
        <Text style={itemPickupText} note ><Text style={label} >Persona: </Text>{person[0].name} {person[0].lastName}</Text>
        <Text style={itemPickupText} note><Text style={label} >Cultivo: </Text>{crop[0].type}</Text>
        <Text style={itemPickupText} note><Text style={label} >Variedad: </Text>{crop[0].variety}</Text>

      </Body>
      <Right style={itemPickupText}>
        <Text style={itemPickupText} note><Text style={label} >Lote: </Text>{crop[0].name}</Text>
        <Text style={weightText} note><Text style={label} ></Text>{item.weight} KGS</Text>

      </Right>
    </ListItem>
    </View>

    


  );
  }
  render() {

    let Home = realm.objects('Pickup').sorted('creationDate',true);
    const dataSource = ds.cloneWithRows(Home);    

   const { ContainerStyle, title, HeaderStyle, ListItemPickupStyle } = styles;
    return (
      <Container>
        <Header style={HeaderStyle}>
          <Left/>
          <Body>
            <Title>
              Cosecha
            </Title>
          </Body>
          <Right>
            <Button onPress={this.goToPickupAdd.bind(this)} transparent>
              <Icon name='add' />
            </Button>
          </Right>
        </Header>
    <Content>

          <Text style={title}>Rendimento por Lote</Text>
          <PieChartBasic />
          <Text style={title}>Últimas recolecciones</Text>          
          <List>
            <SwipeListView
              enableEmptySections={true}
              dataSource={dataSource}
              renderRow={this.renderRow}
              renderHiddenRow={ data => (
                <View style={styles.backRightBtnRight}>
                  <Text>Left</Text>
                  <Text>Right</Text>
                </View>
              )}
            rightOpenValue={-75}
            disableRightSwipe={true}
            disableLeftSwipe={false}
            />

          </List>
        </Content>
        <FooterMenu />
      </Container>
    );
  }
}

const styles = {
  HeaderStyle: {
    paddingTop:0,
    marginTop:0,
  },
  ListItemPickupStyle:{
    width:'auto',
    marginLeft:0,
    height:80,
    borderColor:'#fff',

  },
  ImagePickupStyle:{
    width:70,
    height:70,
    borderRadius:35,
    marginLeft:5,
    borderTopWidth:1,

  },
  itemPickupText:{
    borderWidth:0,
    borderColor:'#fff',
  },
  separator:{
    borderBottomColor: '#ccc',
    borderBottomWidth: 0.5,
    height:'auto',
    width:'auto',
    flex:1,
  },
  label:{
    fontWeight:'bold',
    marginLeft:0,
    textAlign:'left'
  },
  weightText:{
    fontSize:20,
    fontWeight:'bold',
    marginTop:10,
  },
  title:{
    fontSize:20,
    fontWeight:'bold', 
    backgroundColor:'#FFF',
    padding:10,
  }

};
export default Home
