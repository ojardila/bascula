import React, { Component } from 'react';
import { View, Text, ListView } from 'react-native';
import { connect } from 'react-redux';
import { Container, Content, Header, Left, Body, Button, List,  Icon, Title, ListItem, Right, Thumbnail} from 'native-base';
import { HeaderApp, FooterMenu } from './common';
import { Actions } from 'react-native-router-flux';
import { SwipeListView } from 'react-native-swipe-list-view';

import realm from '../Models';
const ds = new ListView.DataSource({rowHasChanged: (r1, r2) => r1 !== r2});

class Crops extends Component {

  goToCropAdd() {
    Actions.crop_add();
  }

    renderRow(item) {
  const { ListItemPersonStyle, ImagePersonStyle, itemPersonText, separator,label } = styles;
  item.fullName = item.name + " " + item.lastName;
  return (
    <View style={separator}>
    <ListItem  avatar style={ListItemPersonStyle} >

      <Body style={itemPersonText}>
        <Text style={itemPersonText} note ><Text style={label} >Nombre: </Text>{item.name}</Text>
        <Text style={itemPersonText} note><Text style={label} >Cultivo: </Text>{item.type}</Text>
        <Text style={itemPersonText} note><Text style={label} >Variedad: </Text>{item.variety}</Text>

      </Body>
      <Right style={itemPersonText}>
        <Text style={itemPersonText} note><Text style={label} >Hectáreas: </Text>{item.dimension}</Text>
      </Right>
    </ListItem>
    </View>

    


  );
  }
  render() {

    let crops = realm.objects('Crop').sorted('creationDate',true);
    const dataSource = ds.cloneWithRows(crops);    

   const { ContainerStyle, HeaderStyle, ListItemPersonStyle } = styles;
    return (
      <Container>
        <Header style={HeaderStyle}>
          <Left/>
          <Body>
            <Title>
              Lotes
            </Title>
          </Body>
          <Right>
            <Button onPress={this.goToCropAdd.bind(this)} transparent>
              <Icon name='add' />
            </Button>
          </Right>
        </Header>
    <Content>
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
  ListItemPersonStyle:{
    width:'auto',
    marginLeft:0,
    height:80,
    borderColor:'#fff',

  },
  ImagePersonStyle:{
    width:70,
    height:70,
    borderRadius:35,
    marginLeft:5,
    borderTopWidth:1,

  },
  itemPersonText:{
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
  }

};
export default Crops
