package egovframework.shop.main.service.impl;

import javax.annotation.Resource;
import org.springframework.stereotype.Service;
import egovframework.shop.main.service.LoginService;

@Service("loginService")
public class LoginServiceImpl implements LoginService {

    @Resource(name = "loginDAO")
    private LoginDAO loginDAO;

    public void login(String adminId) throws Exception {
        loginDAO.selectAdmin(adminId);
        loginDAO.insertLoginLog(adminId);
    }
}
