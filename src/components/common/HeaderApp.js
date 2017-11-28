import React, { Component } from 'react';
import { Container, Header, Left, Body, Right, Title } from 'native-base';


const HeaderApp = ({ children }) => {

  const { HeaderStyle } = styles;
  return (
      <Container style={HeaderStyle}>
        <Header style={HeaderStyle}>
          <Left/>
          <Body>
            <Title>
              {children}
            </Title>
          </Body>
          <Right />
        </Header>
      </Container>
  );
};

const styles = {
  HeaderStyle: {
    paddingTop:0,
    marginTop:0,
  }


};

export { HeaderApp };