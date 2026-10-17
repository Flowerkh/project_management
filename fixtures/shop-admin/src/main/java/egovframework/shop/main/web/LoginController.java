package egovframework.shop.main.web;

import javax.annotation.Resource;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.RequestMapping;
import egovframework.shop.main.service.LoginService;

@Controller
public class LoginController {

    @Resource(name = "loginService")
    private LoginService loginService;

    @RequestMapping("/loginAction.do")
    public String loginAction(String adminId) throws Exception {
        loginService.login(adminId);
        return "redirect:/main.do";
    }
}
